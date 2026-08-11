import type { ApiGatewayV2Service } from "../../apigateway-v2.js";
import { AwsError } from "../../errors.js";
import {
  ProviderReferenceError,
  type ProductionResourceProvider,
  type ProviderContext,
  type ProviderDeleteResult,
  type ProviderFailed,
  type ProviderPlan,
  type ProviderReadModel,
  type ProviderReadResult,
  type ProviderSchema,
  type ProviderUpdateResult,
  type ProviderValidationIssue,
  validateDeclaredProperties,
} from "./contract.js";
import { invokeJsonService } from "./service-invoker.js";

export const API_GATEWAY_V2_API_TYPE = "AWS::ApiGatewayV2::Api";
export const API_GATEWAY_V2_INTEGRATION_TYPE = "AWS::ApiGatewayV2::Integration";
export const API_GATEWAY_V2_ROUTE_TYPE = "AWS::ApiGatewayV2::Route";
export const API_GATEWAY_V2_DEPLOYMENT_TYPE = "AWS::ApiGatewayV2::Deployment";
export const API_GATEWAY_V2_STAGE_TYPE = "AWS::ApiGatewayV2::Stage";
export const API_GATEWAY_V2_AUTHORIZER_TYPE = "AWS::ApiGatewayV2::Authorizer";
export const API_GATEWAY_V2_DOMAIN_NAME_TYPE = "AWS::ApiGatewayV2::DomainName";
export const API_GATEWAY_V2_API_MAPPING_TYPE = "AWS::ApiGatewayV2::ApiMapping";
export const API_GATEWAY_V2_MODEL_TYPE = "AWS::ApiGatewayV2::Model";
export const API_GATEWAY_V2_INTEGRATION_RESPONSE_TYPE = "AWS::ApiGatewayV2::IntegrationResponse";
export const API_GATEWAY_V2_ROUTE_RESPONSE_TYPE = "AWS::ApiGatewayV2::RouteResponse";

type JsonObject = Record<string, any>;
type Protocol = "HTTP" | "WEBSOCKET";

export interface ApiGatewayV2ApiModel {
  readonly Name: string;
  readonly ProtocolType: Protocol;
  readonly ApiKeySelectionExpression?: string;
  readonly CorsConfiguration?: Readonly<JsonObject>;
  readonly CredentialsArn?: string;
  readonly Description?: string;
  readonly DisableExecuteApiEndpoint: boolean;
  readonly IpAddressType: "ipv4" | "dualstack";
  readonly RouteKey?: string;
  readonly RouteSelectionExpression: string;
  readonly Tags: Readonly<Record<string, string>>;
  readonly Target?: string;
  readonly Version?: string;
}

export interface ApiGatewayV2IntegrationModel {
  readonly ApiId: string;
  readonly ConnectionType: "INTERNET";
  readonly ContentHandlingStrategy?: "CONVERT_TO_BINARY" | "CONVERT_TO_TEXT";
  readonly CredentialsArn?: string;
  readonly Description?: string;
  readonly IntegrationMethod?: string;
  readonly IntegrationSubtype?: "SQS-SendMessage";
  readonly IntegrationType: "AWS" | "AWS_PROXY" | "HTTP" | "HTTP_PROXY" | "MOCK";
  readonly IntegrationUri?: string;
  readonly PassthroughBehavior?: "WHEN_NO_MATCH" | "WHEN_NO_TEMPLATES" | "NEVER";
  readonly PayloadFormatVersion?: "1.0" | "2.0";
  readonly RequestParameters: Readonly<Record<string, string>>;
  readonly RequestTemplates: Readonly<Record<string, string>>;
  readonly ResponseParameters: Readonly<JsonObject>;
  readonly TemplateSelectionExpression?: string;
  readonly TimeoutInMillis: number;
}

export interface ApiGatewayV2RouteModel {
  readonly ApiId: string;
  readonly ApiKeyRequired: boolean;
  readonly AuthorizationScopes: readonly string[];
  readonly AuthorizationType: "NONE" | "AWS_IAM" | "CUSTOM" | "JWT";
  readonly AuthorizerId?: string;
  readonly ModelSelectionExpression?: string;
  readonly OperationName?: string;
  readonly RequestModels: Readonly<Record<string, string>>;
  readonly RequestParameters: Readonly<JsonObject>;
  readonly RouteKey: string;
  readonly RouteResponseSelectionExpression?: string;
  readonly Target?: string;
}

export interface ApiGatewayV2DeploymentModel {
  readonly ApiId: string;
  readonly Description?: string;
  readonly StageName?: string;
}

export interface ApiGatewayV2StageModel {
  readonly AccessLogSettings?: Readonly<JsonObject>;
  readonly ApiId: string;
  readonly AutoDeploy: boolean;
  readonly DefaultRouteSettings: Readonly<JsonObject>;
  readonly DeploymentId?: string;
  readonly Description?: string;
  readonly RouteSettings: Readonly<Record<string, JsonObject>>;
  readonly StageName: string;
  readonly StageVariables: Readonly<Record<string, string>>;
  readonly Tags: Readonly<Record<string, string>>;
}

export interface ApiGatewayV2AuthorizerModel {
  readonly ApiId: string;
  readonly AuthorizerCredentialsArn?: string;
  readonly AuthorizerPayloadFormatVersion?: "1.0" | "2.0";
  readonly AuthorizerResultTtlInSeconds: number;
  readonly AuthorizerType: "REQUEST" | "JWT";
  readonly AuthorizerUri?: string;
  readonly EnableSimpleResponses: boolean;
  readonly IdentitySource: readonly string[];
  readonly JwtConfiguration?: { readonly Audience: readonly string[]; readonly Issuer: string };
  readonly Name: string;
}

export interface ApiGatewayV2DomainNameModel {
  readonly DomainName: string;
  readonly DomainNameConfigurations: readonly JsonObject[];
  readonly MutualTlsAuthentication?: Readonly<JsonObject>;
  readonly RoutingMode: "API_MAPPING_ONLY" | "ROUTING_RULE_ONLY" | "ROUTING_RULE_THEN_API_MAPPING";
  readonly Tags: Readonly<Record<string, string>>;
}

export interface ApiGatewayV2ApiMappingModel {
  readonly ApiId: string;
  readonly ApiMappingKey?: string;
  readonly DomainName: string;
  readonly Stage: string;
}

export interface ApiGatewayV2ModelModel {
  readonly ApiId: string;
  readonly ContentType?: string;
  readonly Description?: string;
  readonly Name: string;
  readonly Schema: any;
}

export interface ApiGatewayV2IntegrationResponseModel {
  readonly ApiId: string;
  readonly ContentHandlingStrategy?: "CONVERT_TO_BINARY" | "CONVERT_TO_TEXT";
  readonly IntegrationId: string;
  readonly IntegrationResponseKey: string;
  readonly ResponseParameters: Readonly<Record<string, string>>;
  readonly ResponseTemplates: Readonly<Record<string, string>>;
  readonly TemplateSelectionExpression?: string;
}

export interface ApiGatewayV2RouteResponseModel {
  readonly ApiId: string;
  readonly ModelSelectionExpression?: string;
  readonly ResponseModels: Readonly<Record<string, string>>;
  readonly ResponseParameters: Readonly<JsonObject>;
  readonly RouteId: string;
  readonly RouteResponseKey: string;
}

const RETENTION = Object.freeze({
  deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
  updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
  snapshotSupported: false,
});
const NO_TAGS = Object.freeze({ behavior: "NONE" as const, propagatesCloudFormationTags: false });
// API Gateway v2 CloudFormation tags are an object rather than the Tag[] shape
// used by the generic stack-tag merger. Keep the official property shape here.
const OBJECT_TAGS = Object.freeze({ behavior: "RESOURCE_PROPERTY" as const, propertyName: "Tags", propagatesCloudFormationTags: false });
const CREATE_BEFORE_DELETE = Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" as const });
const STAGE_DELETE_BEFORE_CREATE = Object.freeze({ defaultOrder: "DELETE_BEFORE_CREATE" as const, deleteBeforeCreateReason: "Stage names are unique within an API, including replacements that retain the same StageName." });
const AUTHORIZER_DELETE_BEFORE_CREATE = Object.freeze({ defaultOrder: "DELETE_BEFORE_CREATE" as const, deleteBeforeCreateReason: "Authorizer names are unique within an API, so a type replacement cannot create the same name concurrently." });
const DOMAIN_DELETE_BEFORE_CREATE = Object.freeze({ defaultOrder: "DELETE_BEFORE_CREATE" as const, deleteBeforeCreateReason: "Custom domain names are account/Region unique, including bounded replacements which retain DomainName." });

const stringProperty = (updateBehavior: "MUTABLE" | "REPLACEMENT" | "CONDITIONAL_REPLACEMENT" | "NOT_SUPPORTED", required = false) => Object.freeze({ valueType: "string" as const, updateBehavior, ...(required ? { required: true } : {}) });
const booleanProperty = (updateBehavior: "MUTABLE" | "REPLACEMENT" | "CONDITIONAL_REPLACEMENT" | "NOT_SUPPORTED") => Object.freeze({ valueType: "boolean" as const, updateBehavior });
const numberProperty = (updateBehavior: "MUTABLE" | "REPLACEMENT" | "CONDITIONAL_REPLACEMENT" | "NOT_SUPPORTED") => Object.freeze({ valueType: "number" as const, updateBehavior });
const objectProperty = (updateBehavior: "MUTABLE" | "REPLACEMENT" | "CONDITIONAL_REPLACEMENT" | "NOT_SUPPORTED") => Object.freeze({ valueType: "object" as const, updateBehavior });
const arrayProperty = (updateBehavior: "MUTABLE" | "REPLACEMENT" | "CONDITIONAL_REPLACEMENT" | "NOT_SUPPORTED") => Object.freeze({ valueType: "array" as const, updateBehavior });

export const API_GATEWAY_V2_API_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_V2_API_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    Name: stringProperty("MUTABLE", true), ProtocolType: stringProperty("REPLACEMENT", true),
    ApiKeySelectionExpression: stringProperty("MUTABLE"), CorsConfiguration: objectProperty("MUTABLE"),
    CredentialsArn: stringProperty("MUTABLE"), Description: stringProperty("MUTABLE"),
    DisableExecuteApiEndpoint: booleanProperty("MUTABLE"), IpAddressType: stringProperty("MUTABLE"),
    RouteKey: stringProperty("MUTABLE"), RouteSelectionExpression: stringProperty("MUTABLE"),
    Tags: objectProperty("MUTABLE"), Target: stringProperty("CONDITIONAL_REPLACEMENT"), Version: stringProperty("MUTABLE"),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "API identifier." }),
  attributes: Object.freeze({ ApiEndpoint: Object.freeze({ valueType: "string" }), ApiId: Object.freeze({ valueType: "string" }) }),
  replacement: CREATE_BEFORE_DELETE, retention: RETENTION, tags: OBJECT_TAGS,
});

export const API_GATEWAY_V2_INTEGRATION_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_V2_INTEGRATION_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    ApiId: stringProperty("REPLACEMENT", true), ConnectionType: stringProperty("MUTABLE"),
    ContentHandlingStrategy: stringProperty("CONDITIONAL_REPLACEMENT"), CredentialsArn: stringProperty("MUTABLE"),
    Description: stringProperty("MUTABLE"), IntegrationMethod: stringProperty("MUTABLE"),
    IntegrationSubtype: stringProperty("CONDITIONAL_REPLACEMENT"), IntegrationType: stringProperty("MUTABLE", true),
    IntegrationUri: stringProperty("MUTABLE"), PassthroughBehavior: stringProperty("CONDITIONAL_REPLACEMENT"),
    PayloadFormatVersion: stringProperty("MUTABLE"), RequestParameters: objectProperty("MUTABLE"),
    RequestTemplates: objectProperty("MUTABLE"), ResponseParameters: objectProperty("MUTABLE"),
    TemplateSelectionExpression: stringProperty("MUTABLE"), TimeoutInMillis: numberProperty("MUTABLE"),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Integration identifier." }),
  attributes: Object.freeze({ IntegrationId: Object.freeze({ valueType: "string" }) }),
  replacement: CREATE_BEFORE_DELETE, retention: RETENTION, tags: NO_TAGS,
});

export const API_GATEWAY_V2_ROUTE_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_V2_ROUTE_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    ApiId: stringProperty("REPLACEMENT", true), ApiKeyRequired: booleanProperty("MUTABLE"),
    AuthorizationScopes: arrayProperty("MUTABLE"), AuthorizationType: stringProperty("MUTABLE"),
    AuthorizerId: stringProperty("MUTABLE"), ModelSelectionExpression: stringProperty("MUTABLE"),
    OperationName: stringProperty("MUTABLE"), RequestModels: objectProperty("MUTABLE"),
    RequestParameters: objectProperty("MUTABLE"), RouteKey: stringProperty("MUTABLE", true),
    RouteResponseSelectionExpression: stringProperty("MUTABLE"), Target: stringProperty("MUTABLE"),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Route identifier." }),
  attributes: Object.freeze({ RouteId: Object.freeze({ valueType: "string" }) }),
  replacement: CREATE_BEFORE_DELETE, retention: RETENTION, tags: NO_TAGS,
});

export const API_GATEWAY_V2_DEPLOYMENT_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_V2_DEPLOYMENT_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({ ApiId: stringProperty("REPLACEMENT", true), Description: stringProperty("REPLACEMENT"), StageName: stringProperty("REPLACEMENT") }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Deployment identifier." }),
  attributes: Object.freeze({ DeploymentId: Object.freeze({ valueType: "string" }) }),
  replacement: CREATE_BEFORE_DELETE, retention: RETENTION, tags: NO_TAGS,
});

export const API_GATEWAY_V2_STAGE_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_V2_STAGE_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    AccessLogSettings: objectProperty("MUTABLE"), ApiId: stringProperty("REPLACEMENT", true), AutoDeploy: booleanProperty("MUTABLE"),
    DefaultRouteSettings: objectProperty("CONDITIONAL_REPLACEMENT"), DeploymentId: stringProperty("MUTABLE"), Description: stringProperty("MUTABLE"),
    RouteSettings: objectProperty("MUTABLE"), StageName: stringProperty("REPLACEMENT", true), StageVariables: objectProperty("MUTABLE"), Tags: objectProperty("MUTABLE"),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Stage name." }), attributes: Object.freeze({}),
  replacement: STAGE_DELETE_BEFORE_CREATE, retention: RETENTION, tags: OBJECT_TAGS,
});

export const API_GATEWAY_V2_AUTHORIZER_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_V2_AUTHORIZER_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    ApiId: stringProperty("REPLACEMENT", true), AuthorizerCredentialsArn: stringProperty("MUTABLE"),
    AuthorizerPayloadFormatVersion: stringProperty("MUTABLE"), AuthorizerResultTtlInSeconds: numberProperty("MUTABLE"),
    AuthorizerType: stringProperty("CONDITIONAL_REPLACEMENT", true), AuthorizerUri: stringProperty("MUTABLE"), EnableSimpleResponses: booleanProperty("MUTABLE"),
    IdentitySource: arrayProperty("MUTABLE"), JwtConfiguration: objectProperty("MUTABLE"), Name: stringProperty("MUTABLE", true),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Authorizer identifier." }),
  attributes: Object.freeze({ AuthorizerId: Object.freeze({ valueType: "string" }) }),
  replacement: AUTHORIZER_DELETE_BEFORE_CREATE, retention: RETENTION, tags: NO_TAGS,
});

export const API_GATEWAY_V2_DOMAIN_NAME_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_V2_DOMAIN_NAME_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    DomainName: stringProperty("REPLACEMENT", true), DomainNameConfigurations: arrayProperty("MUTABLE"),
    MutualTlsAuthentication: objectProperty("CONDITIONAL_REPLACEMENT"), RoutingMode: stringProperty("MUTABLE"), Tags: objectProperty("MUTABLE"),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Custom domain name." }),
  attributes: Object.freeze({
    DomainNameArn: Object.freeze({ valueType: "string" }), RegionalDomainName: Object.freeze({ valueType: "string" }),
    RegionalHostedZoneId: Object.freeze({ valueType: "string" }),
  }),
  replacement: DOMAIN_DELETE_BEFORE_CREATE, retention: RETENTION, tags: OBJECT_TAGS,
});

export const API_GATEWAY_V2_API_MAPPING_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_V2_API_MAPPING_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    ApiId: stringProperty("MUTABLE", true), ApiMappingKey: stringProperty("MUTABLE"), DomainName: stringProperty("REPLACEMENT", true), Stage: stringProperty("MUTABLE", true),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "API mapping identifier." }),
  attributes: Object.freeze({ ApiMappingId: Object.freeze({ valueType: "string" }) }),
  replacement: CREATE_BEFORE_DELETE, retention: RETENTION, tags: NO_TAGS,
});

export const API_GATEWAY_V2_MODEL_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_V2_MODEL_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    ApiId: stringProperty("REPLACEMENT", true), ContentType: stringProperty("MUTABLE"), Description: stringProperty("MUTABLE"), Name: stringProperty("MUTABLE", true),
    Schema: Object.freeze({ valueType: "any" as const, required: true, updateBehavior: "MUTABLE" as const }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Model identifier." }),
  attributes: Object.freeze({ ModelId: Object.freeze({ valueType: "string" }) }),
  replacement: CREATE_BEFORE_DELETE, retention: RETENTION, tags: NO_TAGS,
});

export const API_GATEWAY_V2_INTEGRATION_RESPONSE_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_V2_INTEGRATION_RESPONSE_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    ApiId: stringProperty("REPLACEMENT", true), ContentHandlingStrategy: stringProperty("MUTABLE"), IntegrationId: stringProperty("REPLACEMENT", true),
    IntegrationResponseKey: stringProperty("MUTABLE", true), ResponseParameters: objectProperty("MUTABLE"), ResponseTemplates: objectProperty("MUTABLE"),
    TemplateSelectionExpression: stringProperty("MUTABLE"),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Integration response identifier." }),
  attributes: Object.freeze({ IntegrationResponseId: Object.freeze({ valueType: "string" }) }),
  replacement: CREATE_BEFORE_DELETE, retention: RETENTION, tags: NO_TAGS,
});

export const API_GATEWAY_V2_ROUTE_RESPONSE_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_V2_ROUTE_RESPONSE_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    ApiId: stringProperty("REPLACEMENT", true), ModelSelectionExpression: stringProperty("MUTABLE"), ResponseModels: objectProperty("MUTABLE"),
    ResponseParameters: objectProperty("MUTABLE"), RouteId: stringProperty("REPLACEMENT", true), RouteResponseKey: stringProperty("MUTABLE", true),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Route response identifier." }),
  attributes: Object.freeze({ RouteResponseId: Object.freeze({ valueType: "string" }) }),
  replacement: CREATE_BEFORE_DELETE, retention: RETENTION, tags: NO_TAGS,
});

function isObject(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function optionalString(value: unknown): string | undefined { return value === undefined || value === null || value === "" ? undefined : String(value); }
function canonicalJson(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]));
}
function stringMap(value: unknown): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(Object.entries(isObject(value) ? value : {}).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, String(item)])));
}
function tags(value: unknown): Readonly<Record<string, string>> { return stringMap(value); }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function issue(path: string, message: string, code: ProviderValidationIssue["code"] = "InvalidProperty"): ProviderValidationIssue { return { code, path, message }; }
function throwIssues(issues: readonly ProviderValidationIssue[]): void { if (issues.length) throw new TypeError(issues.map(value => `${value.path}: ${value.message}`).join("; ")); }
function failure(error: unknown): ProviderFailed {
  if (error instanceof AwsError) return { status: "FAILED", errorCode: error.code, message: error.message, ...(error.status >= 500 ? { retryable: true } : {}) };
  return { status: "FAILED", errorCode: "InternalFailure", message: error instanceof Error ? error.message : String(error), retryable: true };
}
function isMissing(error: unknown): boolean { return error instanceof AwsError && ["NotFoundException", "ResourceNotFoundException"].includes(error.code); }
async function call<T>(service: ApiGatewayV2Service, method: string, path: string, input?: unknown, cloudFormationIdempotencyKey?: string): Promise<T> {
  return (await invokeJsonService<T>({ method, path, input, cloudFormationIdempotencyKey, handle: service.handle.bind(service) })).body;
}
function segment(value: string): string { return encodeURIComponent(value); }
function physical(kind: string, values: readonly string[]): string { return `stacksim:apigatewayv2:${kind}:${Buffer.from(JSON.stringify(values)).toString("base64url")}`; }
function parsePhysical(value: string, kind: string, count: number): string[] {
  const prefix = `stacksim:apigatewayv2:${kind}:`;
  try {
    const parts = JSON.parse(Buffer.from(value.startsWith(prefix) ? value.slice(prefix.length) : "", "base64url").toString("utf8"));
    if (!Array.isArray(parts) || parts.length !== count || parts.some(part => typeof part !== "string" || !part)) throw new Error();
    return parts;
  } catch { throw new AwsError("InvalidPhysicalResourceId", `Invalid API Gateway v2 ${kind} physical resource identifier`, 400); }
}
function plan<Model>(previous: Model | undefined, desired: Model, schema: ProviderSchema, replacements: readonly string[], conditional?: (name: string, before: any, after: any) => boolean): ProviderPlan<Model> {
  const names = Object.keys(schema.properties).sort();
  if (!previous) return { action: "CREATE", desired, changedProperties: names.filter(name => (desired as any)[name] !== undefined), replacementProperties: [] };
  const changedProperties = names.filter(name => !same((previous as any)[name], (desired as any)[name]));
  if (!changedProperties.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
  const replacementProperties = changedProperties.filter(name => replacements.includes(name) || conditional?.(name, (previous as any)[name], (desired as any)[name]));
  return replacementProperties.length
    ? { action: "REPLACE", desired, changedProperties, replacementProperties, replacementOrder: schema.replacement.defaultOrder }
    : { action: "UPDATE", desired, changedProperties, replacementProperties: [] };
}
function getAtt(typeName: string, schema: ProviderSchema, model: ProviderReadModel<any>, attribute: string): unknown {
  if (!Object.hasOwn(schema.attributes, attribute)) throw new ProviderReferenceError(typeName, `Fn::GetAtt ${attribute}`);
  return model.attributes[attribute];
}
function rejectUnknown(value: unknown, path: string, allowed: readonly string[], issues: ProviderValidationIssue[]): void {
  if (!isObject(value)) return;
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) if (!accepted.has(key)) issues.push(issue(`${path}.${key}`, `${path} does not support ${key}`, "UnsupportedProperty"));
}
function validateStringMap(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (!isObject(value)) return;
  for (const [key, item] of Object.entries(value)) if (typeof item !== "string") issues.push(issue(`${path}.${key}`, `${path}.${key} must be a string`, "InvalidType"));
}
function validateTags(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (!isObject(value)) return;
  if (Object.keys(value).length > 50) issues.push(issue(path, `${path} can contain at most 50 tags`));
  for (const [key, item] of Object.entries(value)) {
    if (!key || key.length > 128 || key.toLowerCase().startsWith("aws:")) issues.push(issue(`${path}.${key}`, "Tag keys must contain 1 to 128 characters and cannot use the aws: prefix"));
    if (typeof item !== "string") issues.push(issue(`${path}.${key}`, "Tag values must be strings", "InvalidType"));
    else if (item.length > 256) issues.push(issue(`${path}.${key}`, "Tag values cannot exceed 256 characters"));
  }
}
function validateRequiredString(input: JsonObject, name: string, issues: ProviderValidationIssue[]): void {
  if (typeof input[name] === "string" && !input[name]) issues.push(issue(`Properties.${name}`, `${name} must not be empty`));
}
function lowerObject(value: unknown): JsonObject | undefined {
  if (!isObject(value)) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key[0].toLowerCase() + key.slice(1), Array.isArray(item) ? item.map(lowerObjectValue) : lowerObjectValue(item)]));
}
function lowerObjectValue(value: any): any { return isObject(value) ? lowerObject(value) : value; }
function upperObject(value: unknown): JsonObject | undefined {
  if (!isObject(value)) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key[0].toUpperCase() + key.slice(1), Array.isArray(item) ? item.map(upperObjectValue) : upperObjectValue(item)]));
}
function upperObjectValue(value: any): any { return isObject(value) ? upperObject(value) : value; }

async function apiProtocol(service: ApiGatewayV2Service, apiId: string): Promise<Protocol> {
  const raw = await call<JsonObject>(service, "GET", `/v2/apis/${segment(apiId)}`);
  if (raw.protocolType !== "HTTP" && raw.protocolType !== "WEBSOCKET") throw new AwsError("BadRequestException", `API ${apiId} has an unsupported protocol`, 400);
  return raw.protocolType;
}

async function requireProtocol(service: ApiGatewayV2Service, apiId: string, expected: Protocol, typeName: string): Promise<void> {
  const actual = await apiProtocol(service, apiId);
  if (actual !== expected) throw new AwsError("BadRequestException", `${typeName} is supported only for ${expected === "WEBSOCKET" ? "WebSocket" : "HTTP"} APIs`, 400);
}

function resourceArn(context: ProviderContext, suffix: string): string { return `arn:${context.partition}:apigateway:${context.region}::${suffix}`; }

async function replaceTags(service: ApiGatewayV2Service, arn: string, before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): Promise<void> {
  const removed = Object.keys(before).filter(key => !Object.hasOwn(after, key));
  if (removed.length) {
    const query = new URLSearchParams(); for (const key of removed) query.append("tagKeys", key);
    await call(service, "DELETE", `/v2/tags/${segment(arn)}?${query.toString()}`);
  }
  const changed = Object.fromEntries(Object.entries(after).filter(([key, value]) => before[key] !== value));
  if (Object.keys(changed).length) await call(service, "POST", `/v2/tags/${segment(arn)}`, { tags: changed });
}

function providerResult<Model>(physicalId: string, model: ProviderReadModel<Model>) { return { status: "SUCCESS" as const, physicalId, model }; }

const LAMBDA_ARN = /^arn:aws(?:-[a-z]+)?:lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9-_]+(?::[A-Za-z0-9-_]+)?$/;
const LAMBDA_URI = /^arn:aws:apigateway:[a-z0-9-]+:lambda:path\/2015-03-31\/functions\/arn:aws(?:-[a-z]+)?:lambda:[^/]+\/invocations$/;
function lambdaTargetLocation(value: string): { region: string; accountId: string; gatewayRegion?: string } | undefined {
  const direct = /^arn:aws(?:-[a-z]+)?:lambda:([a-z0-9-]+):(\d{12}):function:[A-Za-z0-9-_]+(?::[A-Za-z0-9-_]+)?$/.exec(value);
  if (direct) return { region: direct[1], accountId: direct[2] };
  const uri = /^arn:aws:apigateway:([a-z0-9-]+):lambda:path\/2015-03-31\/functions\/arn:aws(?:-[a-z]+)?:lambda:([a-z0-9-]+):(\d{12}):function:[A-Za-z0-9-_]+(?::[A-Za-z0-9-_]+)?\/invocations$/.exec(value);
  if (uri) return { gatewayRegion: uri[1], region: uri[2], accountId: uri[3] };
  return undefined;
}
function validateLocalLambdaTarget(value: unknown, path: string, context: ProviderContext, issues: ProviderValidationIssue[]): void {
  if (typeof value !== "string") return;
  const location = lambdaTargetLocation(value);
  if (location && (location.region !== context.region || location.gatewayRegion !== undefined && location.gatewayRegion !== context.region || location.accountId !== context.accountId)) issues.push(issue(path, "Lambda targets must use this simulator account and Region", "UnsupportedProperty"));
}

function validateSameAccountRoleArn(value: unknown, path: string, context: ProviderContext | undefined, issues: ProviderValidationIssue[]): void {
  if (value === undefined) return;
  if (typeof value !== "string") { issues.push(issue(path, "Credentials must be an IAM role ARN", "InvalidType")); return; }
  const match = /^arn:aws(?:-[a-z]+)?:iam::(\d{12}):role\/[A-Za-z0-9+=,.@_\/-]+$/.exec(value);
  if (!match || context && match[1] !== context.accountId) issues.push(issue(path, "Credentials must be a same-account IAM role ARN", "UnsupportedProperty"));
}

function apiIssues(properties: unknown, context?: ProviderContext): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_V2_API_SCHEMA);
  if (!isObject(properties)) return issues;
  if (typeof properties.Name === "string" && (!properties.Name.trim() || properties.Name.length > 128)) issues.push(issue("Properties.Name", "Name must contain 1 to 128 characters"));
  if (properties.ProtocolType !== undefined && !["HTTP", "WEBSOCKET"].includes(properties.ProtocolType)) issues.push(issue("Properties.ProtocolType", "ProtocolType must be HTTP or WEBSOCKET"));
  if (properties.IpAddressType !== undefined && !["ipv4", "dualstack"].includes(properties.IpAddressType)) issues.push(issue("Properties.IpAddressType", "IpAddressType must be ipv4 or dualstack"));
  validateTags(properties.Tags, "Properties.Tags", issues);
  const protocol = properties.ProtocolType;
  if (protocol === "HTTP") {
    if (properties.ApiKeySelectionExpression !== undefined) issues.push(issue("Properties.ApiKeySelectionExpression", "ApiKeySelectionExpression is supported only for WebSocket APIs", "UnsupportedProperty"));
    if (properties.RouteSelectionExpression !== undefined && properties.RouteSelectionExpression !== "${request.method} ${request.path}") issues.push(issue("Properties.RouteSelectionExpression", "HTTP APIs use ${request.method} ${request.path}"));
    if (properties.RouteKey !== undefined && properties.Target === undefined) issues.push(issue("Properties.RouteKey", "RouteKey is valid only when Target enables quick create"));
    if (properties.CredentialsArn !== undefined && properties.Target === undefined) issues.push(issue("Properties.CredentialsArn", "CredentialsArn is valid only when Target enables quick create"));
    validateSameAccountRoleArn(properties.CredentialsArn, "Properties.CredentialsArn", context, issues);
    if (properties.Target !== undefined && typeof properties.Target === "string" && !(LAMBDA_ARN.test(properties.Target) || LAMBDA_URI.test(properties.Target))) issues.push(issue("Properties.Target", "The bounded quick-create Target must identify a Lambda function; use AWS::ApiGatewayV2::Integration for HTTP endpoints", "UnsupportedProperty"));
    else if (context) validateLocalLambdaTarget(properties.Target, "Properties.Target", context, issues);
    if (isObject(properties.CorsConfiguration)) {
      const path = "Properties.CorsConfiguration";
      rejectUnknown(properties.CorsConfiguration, path, ["AllowCredentials", "AllowHeaders", "AllowMethods", "AllowOrigins", "ExposeHeaders", "MaxAge"], issues);
      for (const name of ["AllowHeaders", "AllowMethods", "AllowOrigins", "ExposeHeaders"]) {
        const value = properties.CorsConfiguration[name];
        if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item))) issues.push(issue(`${path}.${name}`, `${name} must be an array of non-empty strings`, "InvalidType"));
      }
      if (properties.CorsConfiguration.AllowCredentials !== undefined && typeof properties.CorsConfiguration.AllowCredentials !== "boolean") issues.push(issue(`${path}.AllowCredentials`, "AllowCredentials must be a boolean", "InvalidType"));
      const maxAge = properties.CorsConfiguration.MaxAge;
      if (maxAge !== undefined && (typeof maxAge !== "number" || !Number.isInteger(maxAge) || maxAge < 0 || maxAge > 86_400)) issues.push(issue(`${path}.MaxAge`, "MaxAge must be an integer from 0 through 86400"));
      if (properties.CorsConfiguration.AllowCredentials === true && Array.isArray(properties.CorsConfiguration.AllowOrigins) && properties.CorsConfiguration.AllowOrigins.includes("*")) issues.push(issue(`${path}.AllowOrigins`, "Wildcard origins cannot be combined with credentials"));
    }
  }
  if (protocol === "WEBSOCKET") {
    for (const name of ["CorsConfiguration", "CredentialsArn", "RouteKey", "Target"]) if (properties[name] !== undefined) issues.push(issue(`Properties.${name}`, `${name} is supported only for HTTP APIs`, "UnsupportedProperty"));
    if (properties.RouteSelectionExpression === undefined) issues.push(issue("Properties.RouteSelectionExpression", "WebSocket APIs require RouteSelectionExpression"));
    else if (typeof properties.RouteSelectionExpression === "string" && (!properties.RouteSelectionExpression.startsWith("$request.body") || properties.RouteSelectionExpression.length > 256)) issues.push(issue("Properties.RouteSelectionExpression", "WebSocket RouteSelectionExpression must select from $request.body and cannot exceed 256 characters"));
    if (properties.ApiKeySelectionExpression !== undefined && properties.ApiKeySelectionExpression !== "$request.header.x-api-key") issues.push(issue("Properties.ApiKeySelectionExpression", "Only $request.header.x-api-key is available as ApiKeySelectionExpression"));
  }
  return issues;
}

function canonicalApi(properties: unknown, context?: ProviderContext): ApiGatewayV2ApiModel {
  const issues = apiIssues(properties, context); throwIssues(issues); const input = properties as JsonObject;
  const protocol = input.ProtocolType as Protocol;
  return Object.freeze({
    Name: String(input.Name).trim(), ProtocolType: protocol,
    ...(protocol === "WEBSOCKET" ? { ApiKeySelectionExpression: "$request.header.x-api-key" } : {}),
    ...(isObject(input.CorsConfiguration) ? { CorsConfiguration: Object.freeze(canonicalJson(input.CorsConfiguration)) } : {}),
    ...(optionalString(input.CredentialsArn) ? { CredentialsArn: String(input.CredentialsArn) } : {}),
    ...(input.Description !== undefined && input.Description !== "" ? { Description: String(input.Description) } : {}),
    DisableExecuteApiEndpoint: Boolean(input.DisableExecuteApiEndpoint), IpAddressType: input.IpAddressType ?? "ipv4",
    ...(optionalString(input.Target) ? { RouteKey: optionalString(input.RouteKey) ?? "$default" } : {}),
    RouteSelectionExpression: input.RouteSelectionExpression ?? (protocol === "HTTP" ? "${request.method} ${request.path}" : undefined),
    Tags: tags(input.Tags), ...(optionalString(input.Target) ? { Target: String(input.Target) } : {}),
    ...(optionalString(input.Version) ? { Version: String(input.Version) } : {}),
  }) as ApiGatewayV2ApiModel;
}

function apiInput(model: ApiGatewayV2ApiModel, includeQuick = true): JsonObject {
  return {
    name: model.Name, protocolType: model.ProtocolType, description: model.Description, disableExecuteApiEndpoint: model.DisableExecuteApiEndpoint,
    ipAddressType: model.IpAddressType, routeSelectionExpression: model.RouteSelectionExpression, tags: model.Tags, version: model.Version,
    ...(model.CorsConfiguration ? { corsConfiguration: lowerObject(model.CorsConfiguration) } : {}),
    ...(includeQuick && model.Target ? { target: model.Target, routeKey: model.RouteKey, credentialsArn: model.CredentialsArn } : {}),
  };
}

async function managedQuickResources(service: ApiGatewayV2Service, apiId: string): Promise<{ integration?: JsonObject; route?: JsonObject }> {
  const [integrations, routes] = await Promise.all([
    call<JsonObject>(service, "GET", `/v2/apis/${segment(apiId)}/integrations?maxResults=500`),
    call<JsonObject>(service, "GET", `/v2/apis/${segment(apiId)}/routes?maxResults=500`),
  ]);
  return {
    integration: (integrations.items ?? []).find((item: JsonObject) => item.apiGatewayManaged === true),
    route: (routes.items ?? []).find((item: JsonObject) => item.apiGatewayManaged === true),
  };
}

async function apiReadModel(service: ApiGatewayV2Service, apiId: string): Promise<ProviderReadModel<ApiGatewayV2ApiModel>> {
  const raw = await call<JsonObject>(service, "GET", `/v2/apis/${segment(apiId)}`);
  let quick: { integration?: JsonObject; route?: JsonObject } = {};
  if (raw.protocolType === "HTTP") quick = await managedQuickResources(service, apiId);
  const quickCredentials = optionalString(quick.integration?.credentialsArn);
  const quickRouteKey = optionalString(quick.route?.routeKey);
  const quickTarget = optionalString(quick.integration?.integrationUri);
  const model: ApiGatewayV2ApiModel = {
    Name: String(raw.name), ProtocolType: raw.protocolType,
    ...(raw.protocolType === "WEBSOCKET" ? { ApiKeySelectionExpression: "$request.header.x-api-key" } : {}),
    ...(raw.corsConfiguration ? { CorsConfiguration: Object.freeze(canonicalJson(upperObject(raw.corsConfiguration))) } : {}),
    ...(quickCredentials ? { CredentialsArn: quickCredentials } : {}),
    ...(optionalString(raw.description) ? { Description: String(raw.description) } : {}),
    DisableExecuteApiEndpoint: Boolean(raw.disableExecuteApiEndpoint), IpAddressType: raw.ipAddressType ?? "ipv4",
    ...(quickRouteKey ? { RouteKey: quickRouteKey } : {}),
    RouteSelectionExpression: String(raw.routeSelectionExpression), Tags: tags(raw.tags),
    ...(quickTarget ? { Target: quickTarget } : {}),
    ...(optionalString(raw.version) ? { Version: String(raw.version) } : {}),
  };
  return { physicalId: apiId, properties: Object.freeze(model), attributes: { ApiEndpoint: String(raw.apiEndpoint), ApiId: apiId } };
}

async function updateApiQuickResources(service: ApiGatewayV2Service, apiId: string, desired: ApiGatewayV2ApiModel): Promise<void> {
  if (!desired.Target) return;
  const quick = await managedQuickResources(service, apiId);
  if (!quick.integration || !quick.route) throw new AwsError("RequiresReplacement", "Adding quick-create resources to an existing explicit API requires replacement", 409);
  await call(service, "PATCH", `/v2/apis/${segment(apiId)}/integrations/${segment(String(quick.integration.integrationId))}`, {
    integrationType: "AWS_PROXY", integrationUri: desired.Target, integrationMethod: "POST",
    payloadFormatVersion: "2.0", credentialsArn: desired.CredentialsArn ?? "", requestParameters: {}, responseParameters: {},
  });
  if ((desired.RouteKey ?? "$default") !== quick.route.routeKey) await call(service, "PATCH", `/v2/apis/${segment(apiId)}/routes/${segment(String(quick.route.routeId))}`, { routeKey: desired.RouteKey ?? "$default" });
}

export function createApiGatewayV2ApiProvider(service: ApiGatewayV2Service): ProductionResourceProvider<ApiGatewayV2ApiModel> {
  return {
    typeName: API_GATEWAY_V2_API_TYPE, providerVersion: 1, visibility: "production", schema: API_GATEWAY_V2_API_SCHEMA,
    validate(properties, context) { return apiIssues(properties, context); }, canonicalize(properties, context) { return canonicalApi(properties, context); },
    plan(previous, desired) {
      return plan(previous, desired, API_GATEWAY_V2_API_SCHEMA, ["ProtocolType"], (name, before, after) => name === "Target" && (before === undefined) !== (after === undefined));
    },
    async create(desired, context) {
      try {
        const raw = await call<JsonObject>(service, "POST", "/v2/apis", apiInput(desired), context.idempotencyKey);
        const model = await apiReadModel(service, String(raw.apiId)); return providerResult(model.physicalId, model);
      } catch (error) { return failure(error); }
    },
    async read(physicalId): Promise<ProviderReadResult<ApiGatewayV2ApiModel>> {
      try { const model = await apiReadModel(service, physicalId); return providerResult(physicalId, model); }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); }
    },
    async update(physicalId, previous, desired, context): Promise<ProviderUpdateResult<ApiGatewayV2ApiModel>> {
      try {
        if (previous.ProtocolType !== desired.ProtocolType) throw new AwsError("RequiresReplacement", "ProtocolType changes require replacement", 409);
        if ((previous.Target === undefined) !== (desired.Target === undefined)) throw new AwsError("RequiresReplacement", "Changing between explicit and quick-create API shape requires replacement", 409);
        await updateApiQuickResources(service, physicalId, desired);
        if (previous.CorsConfiguration && !desired.CorsConfiguration) await call(service, "DELETE", `/v2/apis/${segment(physicalId)}/cors`);
        await call(service, "PATCH", `/v2/apis/${segment(physicalId)}`, {
          name: desired.Name, description: desired.Description ?? "", disableExecuteApiEndpoint: desired.DisableExecuteApiEndpoint,
          ipAddressType: desired.IpAddressType, routeSelectionExpression: desired.RouteSelectionExpression, version: desired.Version ?? "",
          ...(desired.CorsConfiguration ? { corsConfiguration: lowerObject(desired.CorsConfiguration) } : {}),
        });
        await replaceTags(service, resourceArn(context, `/apis/${physicalId}`), previous.Tags, desired.Tags);
        const model = await apiReadModel(service, physicalId); return providerResult(physicalId, model);
      } catch (error) { return failure(error); }
    },
    async delete(physicalId): Promise<ProviderDeleteResult> {
      try { await call(service, "DELETE", `/v2/apis/${segment(physicalId)}`); return { status: "SUCCESS", physicalId }; }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); }
    },
    ref(model) { return model.physicalId; }, getAtt(model, attribute) { return getAtt(API_GATEWAY_V2_API_TYPE, API_GATEWAY_V2_API_SCHEMA, model, attribute); },
  };
}

function validateIntegrationResponseParameters(value: unknown, issues: ProviderValidationIssue[]): void {
  if (!isObject(value)) return;
  for (const [status, rawList] of Object.entries(value)) {
    const path = `Properties.ResponseParameters.${status}`;
    if (!/^[2-5][0-9]{2}$/.test(status)) issues.push(issue(path, "ResponseParameters keys must be HTTP status codes from 200 through 599"));
    if (!isObject(rawList)) { issues.push(issue(path, "Response parameter list must be an object", "InvalidType")); continue; }
    rejectUnknown(rawList, path, ["ResponseParameters"], issues);
    if (rawList.ResponseParameters !== undefined && !Array.isArray(rawList.ResponseParameters)) { issues.push(issue(`${path}.ResponseParameters`, "ResponseParameters must be an array", "InvalidType")); continue; }
    for (const [index, raw] of (rawList.ResponseParameters ?? []).entries()) {
      const itemPath = `${path}.ResponseParameters[${index}]`;
      if (!isObject(raw)) { issues.push(issue(itemPath, "Response parameter must be an object", "InvalidType")); continue; }
      rejectUnknown(raw, itemPath, ["Destination", "Source"], issues);
      if (typeof raw.Destination !== "string" || !raw.Destination) issues.push(issue(`${itemPath}.Destination`, "Destination is required"));
      if (typeof raw.Source !== "string") issues.push(issue(`${itemPath}.Source`, "Source is required and must be a string"));
      if (typeof raw.Destination === "string" && !(raw.Destination === "overwrite:statuscode" || /^(?:append|overwrite|remove):header\.[A-Za-z0-9._-]+$/i.test(raw.Destination))) issues.push(issue(`${itemPath}.Destination`, "Destination must modify a response header or overwrite the status code"));
    }
  }
}

function canonicalIntegrationResponseParameters(value: unknown): Readonly<JsonObject> {
  const result: JsonObject = {};
  for (const [status, raw] of Object.entries(isObject(value) ? value : {}).sort(([left], [right]) => left.localeCompare(right))) {
    const entries: JsonObject[] = Array.isArray((raw as JsonObject).ResponseParameters) ? (raw as JsonObject).ResponseParameters : [];
    result[status] = Object.freeze({ ResponseParameters: Object.freeze(entries.map((item: JsonObject) => Object.freeze({ Destination: String(item.Destination), Source: String(item.Source) })).sort((left: JsonObject, right: JsonObject) => String(left.Destination).localeCompare(String(right.Destination)))) });
  }
  return Object.freeze(result);
}

function integrationResponseServiceInput(value: Readonly<JsonObject>): JsonObject {
  return Object.fromEntries(Object.entries(value).map(([status, raw]) => [status, Object.fromEntries((raw.ResponseParameters ?? []).map((item: JsonObject) => [item.Destination, item.Source]))]));
}

function integrationResponseFromService(value: unknown): Readonly<JsonObject> {
  const output: JsonObject = {};
  for (const [status, mappings] of Object.entries(isObject(value) ? value : {}).sort(([left], [right]) => left.localeCompare(right))) {
    output[status] = Object.freeze({ ResponseParameters: Object.freeze(Object.entries(isObject(mappings) ? mappings : {}).sort(([left], [right]) => left.localeCompare(right)).map(([Destination, Source]) => Object.freeze({ Destination, Source: String(Source) }))) });
  }
  return Object.freeze(output);
}

function integrationIssues(properties: unknown, context?: ProviderContext): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_V2_INTEGRATION_SCHEMA);
  if (!isObject(properties)) return issues;
  validateRequiredString(properties, "ApiId", issues); validateRequiredString(properties, "IntegrationType", issues);
  if (properties.ConnectionType !== undefined && properties.ConnectionType !== "INTERNET") issues.push(issue("Properties.ConnectionType", "Only INTERNET integrations are available; VPC_LINK requires unavailable VPC networking", "UnsupportedProperty"));
  if (properties.ContentHandlingStrategy !== undefined && !["CONVERT_TO_BINARY", "CONVERT_TO_TEXT"].includes(properties.ContentHandlingStrategy)) issues.push(issue("Properties.ContentHandlingStrategy", "ContentHandlingStrategy must be CONVERT_TO_BINARY or CONVERT_TO_TEXT"));
  if (properties.PassthroughBehavior !== undefined && !["WHEN_NO_MATCH", "WHEN_NO_TEMPLATES", "NEVER"].includes(properties.PassthroughBehavior)) issues.push(issue("Properties.PassthroughBehavior", "PassthroughBehavior is invalid"));
  if (properties.IntegrationSubtype !== undefined && properties.IntegrationSubtype !== "SQS-SendMessage") issues.push(issue("Properties.IntegrationSubtype", "Only the SQS-SendMessage AWS service integration subtype is available", "UnsupportedProperty"));
  if (properties.IntegrationType !== undefined && !["AWS", "AWS_PROXY", "HTTP", "HTTP_PROXY", "MOCK"].includes(properties.IntegrationType)) issues.push(issue("Properties.IntegrationType", "IntegrationType is invalid"));
  if (properties.PayloadFormatVersion !== undefined && !["1.0", "2.0"].includes(properties.PayloadFormatVersion)) issues.push(issue("Properties.PayloadFormatVersion", "PayloadFormatVersion must be 1.0 or 2.0"));
  if (properties.IntegrationMethod !== undefined && !/^(?:ANY|DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT)$/i.test(properties.IntegrationMethod)) issues.push(issue("Properties.IntegrationMethod", "IntegrationMethod is invalid"));
  const timeout = properties.TimeoutInMillis;
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 50 || timeout > 30_000)) issues.push(issue("Properties.TimeoutInMillis", "TimeoutInMillis must be an integer from 50 through 30000"));
  validateSameAccountRoleArn(properties.CredentialsArn, "Properties.CredentialsArn", context, issues);
  if (context) validateLocalLambdaTarget(properties.IntegrationUri, "Properties.IntegrationUri", context, issues);
  validateStringMap(properties.RequestParameters, "Properties.RequestParameters", issues);
  validateStringMap(properties.RequestTemplates, "Properties.RequestTemplates", issues);
  validateIntegrationResponseParameters(properties.ResponseParameters, issues);
  return issues;
}

function canonicalIntegration(properties: unknown, context?: ProviderContext): ApiGatewayV2IntegrationModel {
  const issues = integrationIssues(properties, context); throwIssues(issues); const input = properties as JsonObject;
  const likelyHttp = input.PayloadFormatVersion !== undefined || input.IntegrationSubtype !== undefined || input.ResponseParameters !== undefined;
  return Object.freeze({
    ApiId: String(input.ApiId), ConnectionType: "INTERNET",
    ...(optionalString(input.ContentHandlingStrategy) ? { ContentHandlingStrategy: input.ContentHandlingStrategy } : {}),
    ...(optionalString(input.CredentialsArn) ? { CredentialsArn: String(input.CredentialsArn) } : {}),
    ...(optionalString(input.Description) ? { Description: String(input.Description) } : {}),
    ...(input.IntegrationType !== "MOCK" ? { IntegrationMethod: optionalString(input.IntegrationMethod)?.toUpperCase() ?? (input.IntegrationType === "HTTP_PROXY" && likelyHttp ? "ANY" : "POST") } : {}),
    ...(optionalString(input.IntegrationSubtype) ? { IntegrationSubtype: input.IntegrationSubtype } : {}), IntegrationType: input.IntegrationType,
    ...(optionalString(input.IntegrationUri) ? { IntegrationUri: String(input.IntegrationUri) } : {}),
    ...(optionalString(input.PassthroughBehavior) ? { PassthroughBehavior: input.PassthroughBehavior } : {}),
    ...(optionalString(input.PayloadFormatVersion) ? { PayloadFormatVersion: input.PayloadFormatVersion } : {}),
    RequestParameters: stringMap(input.RequestParameters), RequestTemplates: stringMap(input.RequestTemplates),
    ResponseParameters: canonicalIntegrationResponseParameters(input.ResponseParameters),
    ...(optionalString(input.TemplateSelectionExpression) ? { TemplateSelectionExpression: String(input.TemplateSelectionExpression) } : {}),
    TimeoutInMillis: input.TimeoutInMillis ?? (likelyHttp ? 30_000 : 29_000),
  }) as ApiGatewayV2IntegrationModel;
}

function validateIntegrationForProtocol(model: ApiGatewayV2IntegrationModel, protocol: Protocol): void {
  if (protocol === "HTTP") {
    if (!["AWS_PROXY", "HTTP_PROXY"].includes(model.IntegrationType)) throw new AwsError("BadRequestException", `HTTP APIs do not support ${model.IntegrationType} integrations`, 400);
    for (const [name, value] of [["ContentHandlingStrategy", model.ContentHandlingStrategy], ["PassthroughBehavior", model.PassthroughBehavior], ["RequestTemplates", Object.keys(model.RequestTemplates).length ? model.RequestTemplates : undefined], ["TemplateSelectionExpression", model.TemplateSelectionExpression]] as const) if (value !== undefined) throw new AwsError("BadRequestException", `${name} is supported only for WebSocket APIs`, 400);
    if (!model.PayloadFormatVersion) throw new AwsError("BadRequestException", "HTTP integrations require PayloadFormatVersion", 400);
    if (model.TimeoutInMillis > 30_000) throw new AwsError("BadRequestException", "HTTP integration timeout cannot exceed 30000 milliseconds", 400);
    if (model.IntegrationSubtype === "SQS-SendMessage") {
      if (model.IntegrationType !== "AWS_PROXY" || model.PayloadFormatVersion !== "1.0") throw new AwsError("BadRequestException", "SQS-SendMessage requires AWS_PROXY and payload format 1.0", 400);
      if (model.IntegrationUri) throw new AwsError("BadRequestException", "SQS-SendMessage does not use IntegrationUri", 400);
      if (!model.CredentialsArn) throw new AwsError("BadRequestException", "SQS-SendMessage requires CredentialsArn", 400);
      for (const required of ["QueueUrl", "MessageBody"]) if (!model.RequestParameters[required]) throw new AwsError("BadRequestException", `SQS-SendMessage requires request parameter ${required}`, 400);
    } else if (model.IntegrationType === "AWS_PROXY") {
      if (!model.IntegrationUri || !(LAMBDA_ARN.test(model.IntegrationUri) || LAMBDA_URI.test(model.IntegrationUri))) throw new AwsError("BadRequestException", "HTTP AWS_PROXY integrations must identify a Lambda function", 400);
    } else {
      if (!model.IntegrationUri) throw new AwsError("BadRequestException", "HTTP_PROXY integrations require IntegrationUri", 400);
      try { const target = new URL(model.IntegrationUri); if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.hash) throw new Error(); }
      catch { throw new AwsError("BadRequestException", "HTTP_PROXY IntegrationUri must be a credential-free HTTP/HTTPS URL", 400); }
      if (model.PayloadFormatVersion !== "1.0") throw new AwsError("BadRequestException", "HTTP_PROXY integrations require payload format 1.0", 400);
    }
    return;
  }
  if (model.IntegrationSubtype || model.PayloadFormatVersion || Object.keys(model.ResponseParameters).length) throw new AwsError("BadRequestException", "IntegrationSubtype, PayloadFormatVersion, and ResponseParameters are supported only for HTTP APIs", 400);
  if (model.TimeoutInMillis > 29_000) throw new AwsError("BadRequestException", "WebSocket integration timeout cannot exceed 29000 milliseconds", 400);
  if (["AWS", "AWS_PROXY"].includes(model.IntegrationType)) {
    if (!model.IntegrationUri || !(LAMBDA_ARN.test(model.IntegrationUri) || LAMBDA_URI.test(model.IntegrationUri))) throw new AwsError("BadRequestException", "WebSocket AWS integrations must identify a Lambda function", 400);
    if (model.IntegrationMethod && model.IntegrationMethod !== "POST") throw new AwsError("BadRequestException", "WebSocket Lambda integrations use POST", 400);
  } else if (["HTTP", "HTTP_PROXY"].includes(model.IntegrationType)) {
    if (!model.IntegrationUri) throw new AwsError("BadRequestException", "WebSocket HTTP integrations require IntegrationUri", 400);
    try { const target = new URL(model.IntegrationUri); if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.hash) throw new Error(); }
    catch { throw new AwsError("BadRequestException", "WebSocket HTTP IntegrationUri must be a credential-free HTTP/HTTPS URL", 400); }
  } else if (model.IntegrationUri) throw new AwsError("BadRequestException", "MOCK integrations do not use IntegrationUri", 400);
}

function integrationInput(model: ApiGatewayV2IntegrationModel): JsonObject {
  return {
    connectionType: "INTERNET", contentHandlingStrategy: model.ContentHandlingStrategy, credentialsArn: model.CredentialsArn,
    description: model.Description, integrationMethod: model.IntegrationMethod, integrationSubtype: model.IntegrationSubtype,
    integrationType: model.IntegrationType, integrationUri: model.IntegrationUri, passthroughBehavior: model.PassthroughBehavior,
    payloadFormatVersion: model.PayloadFormatVersion, requestParameters: model.RequestParameters, requestTemplates: model.RequestTemplates,
    responseParameters: integrationResponseServiceInput(model.ResponseParameters), templateSelectionExpression: model.TemplateSelectionExpression,
    timeoutInMillis: model.TimeoutInMillis,
  };
}

function integrationFromRaw(apiId: string, raw: JsonObject): ApiGatewayV2IntegrationModel {
  return Object.freeze({
    ApiId: apiId, ConnectionType: "INTERNET", ...(optionalString(raw.contentHandlingStrategy) ? { ContentHandlingStrategy: raw.contentHandlingStrategy } : {}),
    ...(optionalString(raw.credentialsArn) ? { CredentialsArn: String(raw.credentialsArn) } : {}), ...(optionalString(raw.description) ? { Description: String(raw.description) } : {}),
    ...(optionalString(raw.integrationMethod) ? { IntegrationMethod: String(raw.integrationMethod) } : {}), ...(optionalString(raw.integrationSubtype) ? { IntegrationSubtype: raw.integrationSubtype } : {}),
    IntegrationType: raw.integrationType, ...(optionalString(raw.integrationUri) ? { IntegrationUri: String(raw.integrationUri) } : {}),
    ...(optionalString(raw.passthroughBehavior) ? { PassthroughBehavior: raw.passthroughBehavior } : {}), ...(optionalString(raw.payloadFormatVersion) ? { PayloadFormatVersion: raw.payloadFormatVersion } : {}),
    RequestParameters: stringMap(raw.requestParameters), RequestTemplates: stringMap(raw.requestTemplates), ResponseParameters: integrationResponseFromService(raw.responseParameters),
    ...(optionalString(raw.templateSelectionExpression) ? { TemplateSelectionExpression: String(raw.templateSelectionExpression) } : {}), TimeoutInMillis: Number(raw.timeoutInMillis),
  }) as ApiGatewayV2IntegrationModel;
}

async function integrationReadModel(service: ApiGatewayV2Service, apiId: string, integrationId: string): Promise<ProviderReadModel<ApiGatewayV2IntegrationModel>> {
  const raw = await call<JsonObject>(service, "GET", `/v2/apis/${segment(apiId)}/integrations/${segment(integrationId)}`);
  return { physicalId: physical("integration", [apiId, integrationId]), properties: integrationFromRaw(apiId, raw), attributes: { IntegrationId: integrationId } };
}

export function createApiGatewayV2IntegrationProvider(service: ApiGatewayV2Service): ProductionResourceProvider<ApiGatewayV2IntegrationModel> {
  return {
    typeName: API_GATEWAY_V2_INTEGRATION_TYPE, providerVersion: 1, visibility: "production", schema: API_GATEWAY_V2_INTEGRATION_SCHEMA,
    validate(properties, context) { return integrationIssues(properties, context); }, canonicalize(properties, context) { return canonicalIntegration(properties, context); },
    plan(previous, desired) { return plan(previous, desired, API_GATEWAY_V2_INTEGRATION_SCHEMA, ["ApiId"], (name, before, after) => ["IntegrationSubtype", "ContentHandlingStrategy", "PassthroughBehavior"].includes(name) && before !== undefined && after === undefined); },
    async create(desired, context) {
      try {
        validateIntegrationForProtocol(desired, await apiProtocol(service, desired.ApiId));
        const raw = await call<JsonObject>(service, "POST", `/v2/apis/${segment(desired.ApiId)}/integrations`, integrationInput(desired), context.idempotencyKey);
        const model = await integrationReadModel(service, desired.ApiId, String(raw.integrationId)); return providerResult(model.physicalId, model);
      } catch (error) { return failure(error); }
    },
    async read(physicalId): Promise<ProviderReadResult<ApiGatewayV2IntegrationModel>> {
      try { const [apiId, integrationId] = parsePhysical(physicalId, "integration", 2); const model = await integrationReadModel(service, apiId, integrationId); return providerResult(physicalId, model); }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); }
    },
    async update(physicalId, previous, desired): Promise<ProviderUpdateResult<ApiGatewayV2IntegrationModel>> {
      try {
        const [apiId, integrationId] = parsePhysical(physicalId, "integration", 2);
        if (apiId !== desired.ApiId || previous.ApiId !== desired.ApiId) throw new AwsError("RequiresReplacement", "ApiId changes require replacement", 409);
        for (const name of ["IntegrationSubtype", "ContentHandlingStrategy", "PassthroughBehavior"] as const) if (previous[name] !== undefined && desired[name] === undefined) throw new AwsError("RequiresReplacement", `Removing ${name} requires replacement`, 409);
        validateIntegrationForProtocol(desired, await apiProtocol(service, apiId));
        await call(service, "PATCH", `/v2/apis/${segment(apiId)}/integrations/${segment(integrationId)}`, { ...integrationInput(desired), credentialsArn: desired.CredentialsArn ?? "", description: desired.Description ?? "", integrationUri: desired.IntegrationUri ?? "", templateSelectionExpression: desired.TemplateSelectionExpression ?? "" });
        const model = await integrationReadModel(service, apiId, integrationId); return providerResult(physicalId, model);
      } catch (error) { return failure(error); }
    },
    async delete(physicalId): Promise<ProviderDeleteResult> {
      try { const [apiId, integrationId] = parsePhysical(physicalId, "integration", 2); await call(service, "DELETE", `/v2/apis/${segment(apiId)}/integrations/${segment(integrationId)}`); return { status: "SUCCESS", physicalId }; }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); }
    },
    ref(model) { return String(model.attributes.IntegrationId); }, getAtt(model, attribute) { return getAtt(API_GATEWAY_V2_INTEGRATION_TYPE, API_GATEWAY_V2_INTEGRATION_SCHEMA, model, attribute); },
  };
}

function validateParameterConstraints(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (!isObject(value)) return;
  for (const [key, raw] of Object.entries(value)) {
    const itemPath = `${path}.${key}`;
    if (!isObject(raw)) { issues.push(issue(itemPath, "Parameter constraint must be an object", "InvalidType")); continue; }
    rejectUnknown(raw, itemPath, ["Required"], issues);
    if (typeof raw.Required !== "boolean") issues.push(issue(`${itemPath}.Required`, "Required must be a boolean", "InvalidType"));
  }
}

function canonicalConstraints(value: unknown): Readonly<JsonObject> {
  return Object.freeze(Object.fromEntries(Object.entries(isObject(value) ? value : {}).sort(([left], [right]) => left.localeCompare(right)).map(([key, raw]) => [key, Object.freeze({ Required: Boolean((raw as JsonObject).Required) })])));
}

function constraintsToService(value: Readonly<JsonObject>): JsonObject { return Object.fromEntries(Object.entries(value).map(([key, raw]) => [key, { required: Boolean(raw.Required) }])); }
function constraintsFromService(value: unknown): Readonly<JsonObject> { return Object.freeze(Object.fromEntries(Object.entries(isObject(value) ? value : {}).sort(([left], [right]) => left.localeCompare(right)).map(([key, raw]) => [key, Object.freeze({ Required: Boolean((raw as JsonObject).required) })]))); }

function routeIssues(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_V2_ROUTE_SCHEMA);
  if (!isObject(properties)) return issues;
  validateRequiredString(properties, "ApiId", issues); validateRequiredString(properties, "RouteKey", issues);
  if (properties.AuthorizationType !== undefined && !["NONE", "AWS_IAM", "CUSTOM", "JWT"].includes(properties.AuthorizationType)) issues.push(issue("Properties.AuthorizationType", "AuthorizationType is invalid"));
  if (Array.isArray(properties.AuthorizationScopes)) properties.AuthorizationScopes.forEach((value, index) => { if (typeof value !== "string") issues.push(issue(`Properties.AuthorizationScopes[${index}]`, "AuthorizationScopes entries must be strings", "InvalidType")); });
  if (typeof properties.OperationName === "string" && properties.OperationName.length > 64) issues.push(issue("Properties.OperationName", "OperationName cannot exceed 64 characters"));
  validateStringMap(properties.RequestModels, "Properties.RequestModels", issues); validateParameterConstraints(properties.RequestParameters, "Properties.RequestParameters", issues);
  if (properties.Target !== undefined && (typeof properties.Target !== "string" || !/^integrations\/[A-Za-z0-9]+$/.test(properties.Target))) issues.push(issue("Properties.Target", "Target must use integrations/{integrationId}"));
  return issues;
}

function canonicalRoute(properties: unknown): ApiGatewayV2RouteModel {
  const issues = routeIssues(properties); throwIssues(issues); const input = properties as JsonObject;
  return Object.freeze({
    ApiId: String(input.ApiId), ApiKeyRequired: Boolean(input.ApiKeyRequired),
    AuthorizationScopes: Object.freeze(Array.isArray(input.AuthorizationScopes) ? [...input.AuthorizationScopes].map(String).sort() : []),
    AuthorizationType: input.AuthorizationType ?? "NONE", ...(optionalString(input.AuthorizerId) ? { AuthorizerId: String(input.AuthorizerId) } : {}),
    ...(optionalString(input.ModelSelectionExpression) ? { ModelSelectionExpression: String(input.ModelSelectionExpression) } : {}),
    ...(optionalString(input.OperationName) ? { OperationName: String(input.OperationName) } : {}), RequestModels: stringMap(input.RequestModels),
    RequestParameters: canonicalConstraints(input.RequestParameters), RouteKey: String(input.RouteKey),
    ...(optionalString(input.RouteResponseSelectionExpression) && input.RouteResponseSelectionExpression !== "$default" ? { RouteResponseSelectionExpression: String(input.RouteResponseSelectionExpression) } : {}),
    ...(optionalString(input.Target) ? { Target: String(input.Target) } : {}),
  }) as ApiGatewayV2RouteModel;
}

function validateRouteForProtocol(model: ApiGatewayV2RouteModel, protocol: Protocol): void {
  if (protocol === "HTTP") {
    if (model.ApiKeyRequired || model.ModelSelectionExpression || Object.keys(model.RequestModels).length || Object.keys(model.RequestParameters).length || model.RouteResponseSelectionExpression) throw new AwsError("BadRequestException", "ApiKeyRequired, model/request fields, and RouteResponseSelectionExpression are supported only for WebSocket APIs", 400);
    if (!(model.RouteKey === "$default" || /^(?:ANY|DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT) \/[^?#]*$/.test(model.RouteKey))) throw new AwsError("BadRequestException", "HTTP RouteKey must be $default or METHOD /path", 400);
    if (["CUSTOM", "JWT"].includes(model.AuthorizationType) && !model.AuthorizerId) throw new AwsError("BadRequestException", `${model.AuthorizationType} authorization requires AuthorizerId`, 400);
    if (!["CUSTOM", "JWT"].includes(model.AuthorizationType) && model.AuthorizerId) throw new AwsError("BadRequestException", "AuthorizerId is valid only for CUSTOM or JWT authorization", 400);
    return;
  }
  if (model.AuthorizationType === "JWT" || model.AuthorizationScopes.length) throw new AwsError("BadRequestException", "JWT authorization and AuthorizationScopes are supported only for HTTP APIs", 400);
  if (!model.RouteKey || model.RouteKey.length > 128 || model.RouteKey.startsWith("$") && !["$connect", "$disconnect", "$default"].includes(model.RouteKey)) throw new AwsError("BadRequestException", "Invalid WebSocket RouteKey", 400);
  if (model.RouteKey !== "$connect" && model.AuthorizationType !== "NONE") throw new AwsError("BadRequestException", "WebSocket authorization is supported only on the $connect route", 400);
  if (model.AuthorizationType === "CUSTOM" && !model.AuthorizerId) throw new AwsError("BadRequestException", "CUSTOM authorization requires AuthorizerId", 400);
  if (model.AuthorizationType !== "CUSTOM" && model.AuthorizerId) throw new AwsError("BadRequestException", "AuthorizerId is valid only for CUSTOM authorization", 400);
  if (model.RouteResponseSelectionExpression && model.RouteResponseSelectionExpression !== "$default") throw new AwsError("BadRequestException", "WebSocket RouteResponseSelectionExpression must be $default", 400);
}

function routeInput(model: ApiGatewayV2RouteModel, protocol: Protocol): JsonObject {
  return {
    apiKeyRequired: protocol === "WEBSOCKET" ? model.ApiKeyRequired : undefined,
    authorizationScopes: protocol === "HTTP" ? model.AuthorizationScopes : undefined, authorizationType: model.AuthorizationType,
    authorizerId: model.AuthorizerId, modelSelectionExpression: protocol === "WEBSOCKET" ? model.ModelSelectionExpression : undefined,
    operationName: model.OperationName, requestModels: protocol === "WEBSOCKET" ? model.RequestModels : undefined,
    requestParameters: protocol === "WEBSOCKET" ? constraintsToService(model.RequestParameters) : undefined,
    routeKey: model.RouteKey, routeResponseSelectionExpression: protocol === "WEBSOCKET" ? model.RouteResponseSelectionExpression ?? "$default" : undefined,
    target: model.Target,
  };
}

function routeFromRaw(apiId: string, raw: JsonObject, protocol: Protocol): ApiGatewayV2RouteModel {
  return Object.freeze({
    ApiId: apiId, ApiKeyRequired: protocol === "WEBSOCKET" && Boolean(raw.apiKeyRequired),
    AuthorizationScopes: Object.freeze(protocol === "HTTP" && Array.isArray(raw.authorizationScopes) ? raw.authorizationScopes.map(String).sort() : []),
    AuthorizationType: raw.authorizationType ?? "NONE", ...(optionalString(raw.authorizerId) ? { AuthorizerId: String(raw.authorizerId) } : {}),
    ...(protocol === "WEBSOCKET" && optionalString(raw.modelSelectionExpression) ? { ModelSelectionExpression: String(raw.modelSelectionExpression) } : {}),
    ...(optionalString(raw.operationName) ? { OperationName: String(raw.operationName) } : {}),
    RequestModels: protocol === "WEBSOCKET" ? stringMap(raw.requestModels) : Object.freeze({}),
    RequestParameters: protocol === "WEBSOCKET" ? constraintsFromService(raw.requestParameters) : Object.freeze({}), RouteKey: String(raw.routeKey),
    ...(protocol === "WEBSOCKET" && optionalString(raw.routeResponseSelectionExpression) && raw.routeResponseSelectionExpression !== "$default" ? { RouteResponseSelectionExpression: String(raw.routeResponseSelectionExpression) } : {}),
    ...(optionalString(raw.target) ? { Target: String(raw.target) } : {}),
  }) as ApiGatewayV2RouteModel;
}

async function routeReadModel(service: ApiGatewayV2Service, apiId: string, routeId: string): Promise<ProviderReadModel<ApiGatewayV2RouteModel>> {
  const protocol = await apiProtocol(service, apiId); const raw = await call<JsonObject>(service, "GET", `/v2/apis/${segment(apiId)}/routes/${segment(routeId)}`);
  return { physicalId: physical("route", [apiId, routeId]), properties: routeFromRaw(apiId, raw, protocol), attributes: { RouteId: routeId } };
}

export function createApiGatewayV2RouteProvider(service: ApiGatewayV2Service): ProductionResourceProvider<ApiGatewayV2RouteModel> {
  return {
    typeName: API_GATEWAY_V2_ROUTE_TYPE, providerVersion: 1, visibility: "production", schema: API_GATEWAY_V2_ROUTE_SCHEMA,
    validate(properties) { return routeIssues(properties); }, canonicalize(properties) { return canonicalRoute(properties); },
    plan(previous, desired) { return plan(previous, desired, API_GATEWAY_V2_ROUTE_SCHEMA, ["ApiId"]); },
    async create(desired, context) {
      try { const protocol = await apiProtocol(service, desired.ApiId); validateRouteForProtocol(desired, protocol); const raw = await call<JsonObject>(service, "POST", `/v2/apis/${segment(desired.ApiId)}/routes`, routeInput(desired, protocol), context.idempotencyKey); const model = await routeReadModel(service, desired.ApiId, String(raw.routeId)); return providerResult(model.physicalId, model); }
      catch (error) { return failure(error); }
    },
    async read(physicalId): Promise<ProviderReadResult<ApiGatewayV2RouteModel>> {
      try { const [apiId, routeId] = parsePhysical(physicalId, "route", 2); const model = await routeReadModel(service, apiId, routeId); return providerResult(physicalId, model); }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); }
    },
    async update(physicalId, previous, desired): Promise<ProviderUpdateResult<ApiGatewayV2RouteModel>> {
      try {
        const [apiId, routeId] = parsePhysical(physicalId, "route", 2); if (apiId !== desired.ApiId || previous.ApiId !== desired.ApiId) throw new AwsError("RequiresReplacement", "ApiId changes require replacement", 409);
        const protocol = await apiProtocol(service, apiId); validateRouteForProtocol(desired, protocol);
        await call(service, "PATCH", `/v2/apis/${segment(apiId)}/routes/${segment(routeId)}`, { ...routeInput(desired, protocol), authorizerId: desired.AuthorizerId ?? "", modelSelectionExpression: desired.ModelSelectionExpression ?? "", operationName: desired.OperationName ?? "", target: desired.Target ?? "" });
        const model = await routeReadModel(service, apiId, routeId); return providerResult(physicalId, model);
      } catch (error) { return failure(error); }
    },
    async delete(physicalId): Promise<ProviderDeleteResult> {
      try { const [apiId, routeId] = parsePhysical(physicalId, "route", 2); await call(service, "DELETE", `/v2/apis/${segment(apiId)}/routes/${segment(routeId)}`); return { status: "SUCCESS", physicalId }; }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); }
    },
    ref(model) { return String(model.attributes.RouteId); }, getAtt(model, attribute) { return getAtt(API_GATEWAY_V2_ROUTE_TYPE, API_GATEWAY_V2_ROUTE_SCHEMA, model, attribute); },
  };
}

function deploymentIssues(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_V2_DEPLOYMENT_SCHEMA);
  if (!isObject(properties)) return issues;
  validateRequiredString(properties, "ApiId", issues);
  if (typeof properties.StageName === "string" && (!properties.StageName || properties.StageName.length > 128 || properties.StageName !== "$default" && !/^[A-Za-z0-9_-]+$/.test(properties.StageName))) issues.push(issue("Properties.StageName", "StageName must be $default or contain 1 to 128 letters, digits, underscores, or hyphens"));
  return issues;
}

function canonicalDeployment(properties: unknown): ApiGatewayV2DeploymentModel {
  const issues = deploymentIssues(properties); throwIssues(issues); const input = properties as JsonObject;
  return Object.freeze({ ApiId: String(input.ApiId), ...(optionalString(input.Description) ? { Description: String(input.Description) } : {}), ...(optionalString(input.StageName) ? { StageName: String(input.StageName) } : {}) });
}

async function deploymentReadModel(service: ApiGatewayV2Service, apiId: string, deploymentId: string, declaredStageName?: string): Promise<ProviderReadModel<ApiGatewayV2DeploymentModel>> {
  const raw = await call<JsonObject>(service, "GET", `/v2/apis/${segment(apiId)}/deployments/${segment(deploymentId)}`);
  let StageName: string | undefined;
  if (declaredStageName) {
    try { const stage = await call<JsonObject>(service, "GET", `/v2/apis/${segment(apiId)}/stages/${segment(declaredStageName)}`); if (stage.deploymentId === deploymentId) StageName = declaredStageName; }
    catch (error) { if (!isMissing(error)) throw error; }
  }
  const physicalId = physical("deployment", [apiId, deploymentId, declaredStageName ? `stage:${declaredStageName}` : "none"]);
  return { physicalId, properties: Object.freeze({ ApiId: apiId, ...(optionalString(raw.description) ? { Description: String(raw.description) } : {}), ...(StageName ? { StageName } : {}) }), attributes: { DeploymentId: deploymentId } };
}

export function createApiGatewayV2DeploymentProvider(service: ApiGatewayV2Service): ProductionResourceProvider<ApiGatewayV2DeploymentModel> {
  return {
    typeName: API_GATEWAY_V2_DEPLOYMENT_TYPE, providerVersion: 1, visibility: "production", schema: API_GATEWAY_V2_DEPLOYMENT_SCHEMA,
    validate(properties) { return deploymentIssues(properties); }, canonicalize(properties) { return canonicalDeployment(properties); },
    plan(previous, desired) { return plan(previous, desired, API_GATEWAY_V2_DEPLOYMENT_SCHEMA, ["ApiId", "Description", "StageName"]); },
    async create(desired, context) {
      try { await apiProtocol(service, desired.ApiId); const raw = await call<JsonObject>(service, "POST", `/v2/apis/${segment(desired.ApiId)}/deployments`, { description: desired.Description, stageName: desired.StageName }, context.idempotencyKey); const model = await deploymentReadModel(service, desired.ApiId, String(raw.deploymentId), desired.StageName); return providerResult(model.physicalId, model); }
      catch (error) { return failure(error); }
    },
    async read(physicalId): Promise<ProviderReadResult<ApiGatewayV2DeploymentModel>> {
      try { const [apiId, deploymentId, rawStage] = parsePhysical(physicalId, "deployment", 3); const model = await deploymentReadModel(service, apiId, deploymentId, rawStage.startsWith("stage:") ? rawStage.slice(6) : undefined); return providerResult(physicalId, { ...model, physicalId }); }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); }
    },
    async update(physicalId, previous, desired): Promise<ProviderUpdateResult<ApiGatewayV2DeploymentModel>> {
      if (!same(previous, desired)) return { status: "FAILED", errorCode: "RequiresReplacement", message: "API Gateway v2 deployments are immutable CloudFormation snapshots and property changes require replacement" };
      try { const [apiId, deploymentId, rawStage] = parsePhysical(physicalId, "deployment", 3); const model = await deploymentReadModel(service, apiId, deploymentId, rawStage.startsWith("stage:") ? rawStage.slice(6) : undefined); return providerResult(physicalId, { ...model, physicalId }); }
      catch (error) { return isMissing(error) ? { status: "FAILED", errorCode: "NotFoundException", message: `Deployment ${physicalId} was not found` } : failure(error); }
    },
    async delete(physicalId): Promise<ProviderDeleteResult> {
      try { const [apiId, deploymentId] = parsePhysical(physicalId, "deployment", 3); await call(service, "DELETE", `/v2/apis/${segment(apiId)}/deployments/${segment(deploymentId)}`); return { status: "SUCCESS", physicalId }; }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); }
    },
    ref(model) { return String(model.attributes.DeploymentId); }, getAtt(model, attribute) { return getAtt(API_GATEWAY_V2_DEPLOYMENT_TYPE, API_GATEWAY_V2_DEPLOYMENT_SCHEMA, model, attribute); },
  };
}

const ROUTE_SETTING_NAMES = ["DetailedMetricsEnabled", "ThrottlingBurstLimit", "ThrottlingRateLimit"] as const;

function validateRouteSettings(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (!isObject(value)) return;
  rejectUnknown(value, path, ROUTE_SETTING_NAMES, issues);
  if (value.DetailedMetricsEnabled !== undefined && typeof value.DetailedMetricsEnabled !== "boolean") issues.push(issue(`${path}.DetailedMetricsEnabled`, "DetailedMetricsEnabled must be a boolean", "InvalidType"));
  if (value.ThrottlingBurstLimit !== undefined && (typeof value.ThrottlingBurstLimit !== "number" || !Number.isInteger(value.ThrottlingBurstLimit) || value.ThrottlingBurstLimit < 0)) issues.push(issue(`${path}.ThrottlingBurstLimit`, "ThrottlingBurstLimit must be a non-negative integer"));
  if (value.ThrottlingRateLimit !== undefined && (typeof value.ThrottlingRateLimit !== "number" || !Number.isFinite(value.ThrottlingRateLimit) || value.ThrottlingRateLimit < 0)) issues.push(issue(`${path}.ThrottlingRateLimit`, "ThrottlingRateLimit must be non-negative"));
}

function canonicalRouteSettings(value: unknown): Readonly<JsonObject> {
  const input = isObject(value) ? value : {}; const result: JsonObject = {};
  if (input.DetailedMetricsEnabled !== undefined) result.DetailedMetricsEnabled = Boolean(input.DetailedMetricsEnabled);
  if (input.ThrottlingBurstLimit !== undefined) result.ThrottlingBurstLimit = Number(input.ThrottlingBurstLimit);
  if (input.ThrottlingRateLimit !== undefined) result.ThrottlingRateLimit = Number(input.ThrottlingRateLimit);
  return Object.freeze(result);
}

function routeSettingsMap(value: unknown): Readonly<Record<string, JsonObject>> {
  return Object.freeze(Object.fromEntries(Object.entries(isObject(value) ? value : {}).sort(([left], [right]) => left.localeCompare(right)).map(([key, raw]) => [key, canonicalRouteSettings(raw)])));
}

function stageIssues(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_V2_STAGE_SCHEMA);
  if (!isObject(properties)) return issues;
  validateRequiredString(properties, "ApiId", issues); validateRequiredString(properties, "StageName", issues);
  if (typeof properties.StageName === "string" && (properties.StageName.length > 128 || properties.StageName !== "$default" && !/^[A-Za-z0-9_-]+$/.test(properties.StageName))) issues.push(issue("Properties.StageName", "StageName must be $default or contain letters, digits, underscores, or hyphens"));
  if (properties.AutoDeploy === true && properties.DeploymentId !== undefined) issues.push(issue("Properties.DeploymentId", "DeploymentId cannot be set while AutoDeploy is true"));
  validateRouteSettings(properties.DefaultRouteSettings, "Properties.DefaultRouteSettings", issues);
  if (isObject(properties.RouteSettings)) for (const [key, value] of Object.entries(properties.RouteSettings)) validateRouteSettings(value, `Properties.RouteSettings.${key}`, issues);
  if (isObject(properties.StageVariables)) for (const [key, value] of Object.entries(properties.StageVariables)) {
    if (!/^[A-Za-z0-9]+$/.test(key)) issues.push(issue(`Properties.StageVariables.${key}`, "Stage variable names must be alphanumeric"));
    if (typeof value !== "string" || !value || value.length > 512) issues.push(issue(`Properties.StageVariables.${key}`, "Stage variable values must be non-empty strings of at most 512 characters", typeof value === "string" ? "InvalidProperty" : "InvalidType"));
  }
  if (isObject(properties.AccessLogSettings)) {
    rejectUnknown(properties.AccessLogSettings, "Properties.AccessLogSettings", ["DestinationArn", "Format"], issues);
    for (const name of ["DestinationArn", "Format"]) if (typeof properties.AccessLogSettings[name] !== "string" || !properties.AccessLogSettings[name]) issues.push(issue(`Properties.AccessLogSettings.${name}`, `${name} is required and must be a string`));
    if (typeof properties.AccessLogSettings.Format === "string" && !/\$context\.(?:requestId|extendedRequestId)\b/.test(properties.AccessLogSettings.Format)) issues.push(issue("Properties.AccessLogSettings.Format", "Access log format must contain $context.requestId or $context.extendedRequestId"));
  }
  validateTags(properties.Tags, "Properties.Tags", issues);
  return issues;
}

function canonicalStage(properties: unknown): ApiGatewayV2StageModel {
  const issues = stageIssues(properties); throwIssues(issues); const input = properties as JsonObject;
  const access = isObject(input.AccessLogSettings) ? Object.freeze(canonicalJson(input.AccessLogSettings)) : undefined;
  return Object.freeze({
    ...(access ? { AccessLogSettings: access } : {}), ApiId: String(input.ApiId), AutoDeploy: Boolean(input.AutoDeploy),
    DefaultRouteSettings: canonicalRouteSettings(input.DefaultRouteSettings), ...(optionalString(input.DeploymentId) ? { DeploymentId: String(input.DeploymentId) } : {}),
    ...(optionalString(input.Description) ? { Description: String(input.Description) } : {}), RouteSettings: routeSettingsMap(input.RouteSettings), StageName: String(input.StageName),
    StageVariables: stringMap(input.StageVariables), Tags: tags(input.Tags),
  }) as ApiGatewayV2StageModel;
}

function stageInput(model: ApiGatewayV2StageModel): JsonObject {
  return {
    accessLogSettings: model.AccessLogSettings ? lowerObject(model.AccessLogSettings) : undefined, autoDeploy: model.AutoDeploy,
    defaultRouteSettings: lowerObject(model.DefaultRouteSettings), deploymentId: model.DeploymentId, description: model.Description,
    routeSettings: Object.fromEntries(Object.entries(model.RouteSettings).map(([key, value]) => [key, lowerObject(value)])),
    stageName: model.StageName, stageVariables: model.StageVariables, tags: model.Tags,
  };
}

function stageFromRaw(apiId: string, raw: JsonObject): ApiGatewayV2StageModel {
  return Object.freeze({
    ...(raw.accessLogSettings ? { AccessLogSettings: Object.freeze(canonicalJson(upperObject(raw.accessLogSettings))) } : {}), ApiId: apiId, AutoDeploy: Boolean(raw.autoDeploy),
    DefaultRouteSettings: canonicalRouteSettings(upperObject(raw.defaultRouteSettings)),
    ...(!raw.autoDeploy && optionalString(raw.deploymentId) ? { DeploymentId: String(raw.deploymentId) } : {}), ...(optionalString(raw.description) ? { Description: String(raw.description) } : {}),
    RouteSettings: routeSettingsMap(Object.fromEntries(Object.entries(isObject(raw.routeSettings) ? raw.routeSettings : {}).map(([key, value]) => [key, upperObject(value)]))),
    StageName: String(raw.stageName), StageVariables: stringMap(raw.stageVariables), Tags: tags(raw.tags),
  }) as ApiGatewayV2StageModel;
}

async function stageReadModel(service: ApiGatewayV2Service, apiId: string, stageName: string): Promise<ProviderReadModel<ApiGatewayV2StageModel>> {
  const raw = await call<JsonObject>(service, "GET", `/v2/apis/${segment(apiId)}/stages/${segment(stageName)}`);
  return { physicalId: physical("stage", [apiId, stageName]), properties: stageFromRaw(apiId, raw), attributes: {} };
}

function removedDefaultRouteSetting(previous: ApiGatewayV2StageModel, desired: ApiGatewayV2StageModel): boolean {
  return Object.keys(previous.DefaultRouteSettings).some(key => !Object.hasOwn(desired.DefaultRouteSettings, key));
}

export function createApiGatewayV2StageProvider(service: ApiGatewayV2Service): ProductionResourceProvider<ApiGatewayV2StageModel> {
  return {
    typeName: API_GATEWAY_V2_STAGE_TYPE, providerVersion: 1, visibility: "production", schema: API_GATEWAY_V2_STAGE_SCHEMA,
    validate(properties) { return stageIssues(properties); }, canonicalize(properties) { return canonicalStage(properties); },
    plan(previous, desired) { return plan(previous, desired, API_GATEWAY_V2_STAGE_SCHEMA, ["ApiId", "StageName"], name => name === "DefaultRouteSettings" && previous !== undefined && removedDefaultRouteSetting(previous, desired)); },
    async create(desired, context) {
      try { await apiProtocol(service, desired.ApiId); const raw = await call<JsonObject>(service, "POST", `/v2/apis/${segment(desired.ApiId)}/stages`, stageInput(desired), context.idempotencyKey); const model = await stageReadModel(service, desired.ApiId, String(raw.stageName)); return providerResult(model.physicalId, model); }
      catch (error) { return failure(error); }
    },
    async read(physicalId): Promise<ProviderReadResult<ApiGatewayV2StageModel>> {
      try { const [apiId, stageName] = parsePhysical(physicalId, "stage", 2); const model = await stageReadModel(service, apiId, stageName); return providerResult(physicalId, model); }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); }
    },
    async update(physicalId, previous, desired, context): Promise<ProviderUpdateResult<ApiGatewayV2StageModel>> {
      try {
        const [apiId, stageName] = parsePhysical(physicalId, "stage", 2); if (apiId !== desired.ApiId || stageName !== desired.StageName) throw new AwsError("RequiresReplacement", "ApiId and StageName changes require replacement", 409);
        if (removedDefaultRouteSetting(previous, desired)) throw new AwsError("RequiresReplacement", "Removing a DefaultRouteSettings field requires replacement", 409);
        if (previous.AccessLogSettings && !desired.AccessLogSettings) await call(service, "DELETE", `/v2/apis/${segment(apiId)}/stages/${segment(stageName)}/accesslogsettings`);
        const input = stageInput(desired); delete input.stageName; delete input.tags;
        await call(service, "PATCH", `/v2/apis/${segment(apiId)}/stages/${segment(stageName)}`, { ...input, deploymentId: desired.DeploymentId ?? "", description: desired.Description ?? "" });
        await replaceTags(service, resourceArn(context, `/apis/${apiId}/stages/${stageName}`), previous.Tags, desired.Tags);
        const model = await stageReadModel(service, apiId, stageName); return providerResult(physicalId, model);
      } catch (error) { return failure(error); }
    },
    async delete(physicalId): Promise<ProviderDeleteResult> {
      try { const [apiId, stageName] = parsePhysical(physicalId, "stage", 2); await call(service, "DELETE", `/v2/apis/${segment(apiId)}/stages/${segment(stageName)}`); return { status: "SUCCESS", physicalId }; }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); }
    },
    ref(model) { return model.properties.StageName; }, getAtt(model, attribute) { return getAtt(API_GATEWAY_V2_STAGE_TYPE, API_GATEWAY_V2_STAGE_SCHEMA, model, attribute); },
  };
}

function authorizerIssues(properties: unknown, context?: ProviderContext): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_V2_AUTHORIZER_SCHEMA);
  if (!isObject(properties)) return issues;
  for (const name of ["ApiId", "AuthorizerType", "Name"]) validateRequiredString(properties, name, issues);
  if (properties.AuthorizerType !== undefined && !["REQUEST", "JWT"].includes(properties.AuthorizerType)) issues.push(issue("Properties.AuthorizerType", "AuthorizerType must be REQUEST or JWT"));
  if (typeof properties.Name === "string" && properties.Name.length > 128) issues.push(issue("Properties.Name", "Name cannot exceed 128 characters"));
  if (properties.AuthorizerPayloadFormatVersion !== undefined && !["1.0", "2.0"].includes(properties.AuthorizerPayloadFormatVersion)) issues.push(issue("Properties.AuthorizerPayloadFormatVersion", "AuthorizerPayloadFormatVersion must be 1.0 or 2.0"));
  const ttl = properties.AuthorizerResultTtlInSeconds;
  if (ttl !== undefined && (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 0 || ttl > 3600)) issues.push(issue("Properties.AuthorizerResultTtlInSeconds", "AuthorizerResultTtlInSeconds must be an integer from 0 through 3600"));
  validateSameAccountRoleArn(properties.AuthorizerCredentialsArn, "Properties.AuthorizerCredentialsArn", context, issues);
  if (properties.AuthorizerUri !== undefined && (typeof properties.AuthorizerUri !== "string" || !(LAMBDA_ARN.test(properties.AuthorizerUri) || LAMBDA_URI.test(properties.AuthorizerUri)))) issues.push(issue("Properties.AuthorizerUri", "AuthorizerUri must identify a Lambda function"));
  else if (context) validateLocalLambdaTarget(properties.AuthorizerUri, "Properties.AuthorizerUri", context, issues);
  if (Array.isArray(properties.IdentitySource)) properties.IdentitySource.forEach((value, index) => { if (typeof value !== "string" || !value) issues.push(issue(`Properties.IdentitySource[${index}]`, "IdentitySource entries must be non-empty strings", typeof value === "string" ? "InvalidProperty" : "InvalidType")); });
  if (isObject(properties.JwtConfiguration)) {
    rejectUnknown(properties.JwtConfiguration, "Properties.JwtConfiguration", ["Audience", "Issuer"], issues);
    if (!Array.isArray(properties.JwtConfiguration.Audience) || !properties.JwtConfiguration.Audience.length || properties.JwtConfiguration.Audience.some((value: unknown) => typeof value !== "string" || !value)) issues.push(issue("Properties.JwtConfiguration.Audience", "Audience must be a non-empty array of strings"));
    if (typeof properties.JwtConfiguration.Issuer !== "string") issues.push(issue("Properties.JwtConfiguration.Issuer", "Issuer is required and must be a string"));
    else { try { const issuer = new URL(properties.JwtConfiguration.Issuer); if (!["http:", "https:"].includes(issuer.protocol)) throw new Error(); } catch { issues.push(issue("Properties.JwtConfiguration.Issuer", "Issuer must be an HTTP/HTTPS URL")); } }
  }
  return issues;
}

function canonicalAuthorizer(properties: unknown, context?: ProviderContext): ApiGatewayV2AuthorizerModel {
  const issues = authorizerIssues(properties, context); throwIssues(issues); const input = properties as JsonObject;
  const jwt = isObject(input.JwtConfiguration) ? Object.freeze({ Audience: Object.freeze([...input.JwtConfiguration.Audience].map(String).sort()), Issuer: String(input.JwtConfiguration.Issuer).replace(/\/$/, "") }) : undefined;
  return Object.freeze({
    ApiId: String(input.ApiId), ...(optionalString(input.AuthorizerCredentialsArn) ? { AuthorizerCredentialsArn: String(input.AuthorizerCredentialsArn) } : {}),
    ...(optionalString(input.AuthorizerPayloadFormatVersion) ? { AuthorizerPayloadFormatVersion: input.AuthorizerPayloadFormatVersion } : {}),
    AuthorizerResultTtlInSeconds: input.AuthorizerResultTtlInSeconds ?? 300, AuthorizerType: input.AuthorizerType,
    ...(optionalString(input.AuthorizerUri) ? { AuthorizerUri: String(input.AuthorizerUri) } : {}), EnableSimpleResponses: Boolean(input.EnableSimpleResponses),
    IdentitySource: Object.freeze(Array.isArray(input.IdentitySource) ? input.IdentitySource.map(String) : []), ...(jwt ? { JwtConfiguration: jwt } : {}), Name: String(input.Name).trim(),
  }) as ApiGatewayV2AuthorizerModel;
}

function validateAuthorizerForProtocol(model: ApiGatewayV2AuthorizerModel, protocol: Protocol): void {
  if (protocol === "WEBSOCKET") {
    if (model.AuthorizerType !== "REQUEST") throw new AwsError("BadRequestException", "WebSocket APIs support only REQUEST authorizers", 400);
    if (!model.AuthorizerUri) throw new AwsError("BadRequestException", "WebSocket REQUEST authorizers require AuthorizerUri", 400);
    if (model.EnableSimpleResponses || model.JwtConfiguration) throw new AwsError("BadRequestException", "EnableSimpleResponses and JwtConfiguration are supported only for HTTP APIs", 400);
    if (model.IdentitySource.some(value => !/^route\.request\.(?:header|querystring)\.[A-Za-z0-9._-]+$/i.test(value))) throw new AwsError("BadRequestException", "WebSocket IdentitySource entries must use route.request header or querystring expressions", 400);
    if (model.AuthorizerResultTtlInSeconds > 0 && !model.IdentitySource.length) throw new AwsError("BadRequestException", "IdentitySource is required when authorizer caching is enabled", 400);
    return;
  }
  if (model.AuthorizerType === "JWT") {
    if (!model.JwtConfiguration) throw new AwsError("BadRequestException", "JWT authorizers require JwtConfiguration", 400);
    if (model.AuthorizerUri || model.AuthorizerCredentialsArn || model.AuthorizerPayloadFormatVersion || model.EnableSimpleResponses) throw new AwsError("BadRequestException", "Lambda authorizer properties are not valid for JWT authorizers", 400);
    if (model.IdentitySource.length !== 1 || !/^\$request\.(?:header|querystring)\.[A-Za-z0-9._-]+$/i.test(model.IdentitySource[0])) throw new AwsError("BadRequestException", "JWT authorizers require one HTTP header or querystring IdentitySource", 400);
    return;
  }
  if (!model.AuthorizerUri) throw new AwsError("BadRequestException", "HTTP REQUEST authorizers require AuthorizerUri", 400);
  if (!model.AuthorizerPayloadFormatVersion) throw new AwsError("BadRequestException", "HTTP REQUEST authorizers require AuthorizerPayloadFormatVersion", 400);
  if (model.JwtConfiguration) throw new AwsError("BadRequestException", "JwtConfiguration is valid only for JWT authorizers", 400);
  if (model.IdentitySource.some(value => !value.startsWith("$request."))) throw new AwsError("BadRequestException", "HTTP REQUEST IdentitySource entries must use $request selection expressions", 400);
  if (model.AuthorizerResultTtlInSeconds > 0 && !model.IdentitySource.length) throw new AwsError("BadRequestException", "IdentitySource is required when authorizer caching is enabled", 400);
  if (model.EnableSimpleResponses && model.AuthorizerPayloadFormatVersion !== "2.0") throw new AwsError("BadRequestException", "Simple responses require authorizer payload format 2.0", 400);
}

function authorizerInput(model: ApiGatewayV2AuthorizerModel, protocol: Protocol): JsonObject {
  return {
    authorizerCredentialsArn: model.AuthorizerCredentialsArn, authorizerPayloadFormatVersion: protocol === "HTTP" ? model.AuthorizerPayloadFormatVersion : undefined,
    authorizerResultTtlInSeconds: model.AuthorizerResultTtlInSeconds, authorizerType: model.AuthorizerType, authorizerUri: model.AuthorizerUri,
    enableSimpleResponses: protocol === "HTTP" ? model.EnableSimpleResponses : undefined, identitySource: model.IdentitySource,
    jwtConfiguration: model.JwtConfiguration ? { audience: model.JwtConfiguration.Audience, issuer: model.JwtConfiguration.Issuer } : undefined, name: model.Name,
  };
}

function authorizerFromRaw(apiId: string, raw: JsonObject, protocol: Protocol): ApiGatewayV2AuthorizerModel {
  const jwt = raw.jwtConfiguration ? Object.freeze({ Audience: Object.freeze(Array.isArray(raw.jwtConfiguration.audience) ? raw.jwtConfiguration.audience.map(String).sort() : []), Issuer: String(raw.jwtConfiguration.issuer) }) : undefined;
  return Object.freeze({
    ApiId: apiId, ...(optionalString(raw.authorizerCredentialsArn) ? { AuthorizerCredentialsArn: String(raw.authorizerCredentialsArn) } : {}),
    ...(protocol === "HTTP" && optionalString(raw.authorizerPayloadFormatVersion) ? { AuthorizerPayloadFormatVersion: raw.authorizerPayloadFormatVersion } : {}),
    AuthorizerResultTtlInSeconds: Number(raw.authorizerResultTtlInSeconds ?? 300), AuthorizerType: raw.authorizerType,
    ...(optionalString(raw.authorizerUri) ? { AuthorizerUri: String(raw.authorizerUri) } : {}), EnableSimpleResponses: protocol === "HTTP" && Boolean(raw.enableSimpleResponses),
    IdentitySource: Object.freeze(Array.isArray(raw.identitySource) ? raw.identitySource.map(String) : []), ...(jwt ? { JwtConfiguration: jwt } : {}), Name: String(raw.name),
  }) as ApiGatewayV2AuthorizerModel;
}

async function authorizerReadModel(service: ApiGatewayV2Service, apiId: string, authorizerId: string): Promise<ProviderReadModel<ApiGatewayV2AuthorizerModel>> {
  const protocol = await apiProtocol(service, apiId); const raw = await call<JsonObject>(service, "GET", `/v2/apis/${segment(apiId)}/authorizers/${segment(authorizerId)}`);
  return { physicalId: physical("authorizer", [apiId, authorizerId]), properties: authorizerFromRaw(apiId, raw, protocol), attributes: { AuthorizerId: authorizerId } };
}

export function createApiGatewayV2AuthorizerProvider(service: ApiGatewayV2Service): ProductionResourceProvider<ApiGatewayV2AuthorizerModel> {
  return {
    typeName: API_GATEWAY_V2_AUTHORIZER_TYPE, providerVersion: 1, visibility: "production", schema: API_GATEWAY_V2_AUTHORIZER_SCHEMA,
    validate(properties, context) { return authorizerIssues(properties, context); }, canonicalize(properties, context) { return canonicalAuthorizer(properties, context); },
    plan(previous, desired) { return plan(previous, desired, API_GATEWAY_V2_AUTHORIZER_SCHEMA, ["ApiId"], name => name === "AuthorizerType"); },
    async create(desired, context) {
      try { const protocol = await apiProtocol(service, desired.ApiId); validateAuthorizerForProtocol(desired, protocol); const raw = await call<JsonObject>(service, "POST", `/v2/apis/${segment(desired.ApiId)}/authorizers`, authorizerInput(desired, protocol), context.idempotencyKey); const model = await authorizerReadModel(service, desired.ApiId, String(raw.authorizerId)); return providerResult(model.physicalId, model); }
      catch (error) { return failure(error); }
    },
    async read(physicalId): Promise<ProviderReadResult<ApiGatewayV2AuthorizerModel>> {
      try { const [apiId, authorizerId] = parsePhysical(physicalId, "authorizer", 2); const model = await authorizerReadModel(service, apiId, authorizerId); return providerResult(physicalId, model); }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); }
    },
    async update(physicalId, previous, desired): Promise<ProviderUpdateResult<ApiGatewayV2AuthorizerModel>> {
      try {
        const [apiId, authorizerId] = parsePhysical(physicalId, "authorizer", 2); if (apiId !== desired.ApiId || previous.ApiId !== desired.ApiId || previous.AuthorizerType !== desired.AuthorizerType) throw new AwsError("RequiresReplacement", "ApiId and AuthorizerType changes require replacement", 409);
        const protocol = await apiProtocol(service, apiId); validateAuthorizerForProtocol(desired, protocol);
        await call(service, "PATCH", `/v2/apis/${segment(apiId)}/authorizers/${segment(authorizerId)}`, {
          ...authorizerInput(desired, protocol),
          ...(desired.AuthorizerType === "REQUEST" ? { authorizerCredentialsArn: desired.AuthorizerCredentialsArn ?? "", authorizerUri: desired.AuthorizerUri ?? "" } : {}),
        });
        const model = await authorizerReadModel(service, apiId, authorizerId); return providerResult(physicalId, model);
      } catch (error) { return failure(error); }
    },
    async delete(physicalId): Promise<ProviderDeleteResult> {
      try { const [apiId, authorizerId] = parsePhysical(physicalId, "authorizer", 2); await call(service, "DELETE", `/v2/apis/${segment(apiId)}/authorizers/${segment(authorizerId)}`); return { status: "SUCCESS", physicalId }; }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); }
    },
    ref(model) { return String(model.attributes.AuthorizerId); }, getAtt(model, attribute) { return getAtt(API_GATEWAY_V2_AUTHORIZER_TYPE, API_GATEWAY_V2_AUTHORIZER_SCHEMA, model, attribute); },
  };
}

const DOMAIN_CONFIGURATION_NAMES = ["CertificateArn", "CertificateName", "EndpointType", "IpAddressType", "OwnershipVerificationCertificateArn", "SecurityPolicy"] as const;

function domainIssues(properties: unknown, context?: ProviderContext): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_V2_DOMAIN_NAME_SCHEMA);
  if (!isObject(properties)) return issues;
  validateRequiredString(properties, "DomainName", issues); validateTags(properties.Tags, "Properties.Tags", issues);
  if (typeof properties.DomainName === "string" && (properties.DomainName.length > 253 || !/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.?$/.test(properties.DomainName.toLowerCase()))) issues.push(issue("Properties.DomainName", "DomainName must be a valid lower-case DNS host name"));
  if (!Array.isArray(properties.DomainNameConfigurations) || properties.DomainNameConfigurations.length !== 1) issues.push(issue("Properties.DomainNameConfigurations", "Exactly one regional DomainNameConfiguration is required"));
  else {
    const config = properties.DomainNameConfigurations[0]; const path = "Properties.DomainNameConfigurations[0]";
    if (!isObject(config)) issues.push(issue(path, "DomainNameConfiguration must be an object", "InvalidType"));
    else {
      rejectUnknown(config, path, DOMAIN_CONFIGURATION_NAMES, issues);
      if (config.EndpointType !== undefined && config.EndpointType !== "REGIONAL") issues.push(issue(`${path}.EndpointType`, "Only REGIONAL custom domains are available"));
      if (config.IpAddressType !== undefined && !["ipv4", "dualstack"].includes(config.IpAddressType)) issues.push(issue(`${path}.IpAddressType`, "IpAddressType must be ipv4 or dualstack"));
      if (config.SecurityPolicy !== undefined && !["TLS_1_0", "TLS_1_2"].includes(config.SecurityPolicy)) issues.push(issue(`${path}.SecurityPolicy`, "SecurityPolicy must be TLS_1_0 or TLS_1_2"));
      const partition = context?.partition ?? "aws(?:-[a-z]+)?"; const region = context?.region ?? "[a-z0-9-]+"; const account = context?.accountId ?? "\\d{12}";
      const localCertificate = new RegExp(`^arn:${partition}:acm:${region}:${account}:certificate\\/[A-Za-z0-9-]+$`);
      if (typeof config.CertificateArn !== "string" || !config.CertificateArn) issues.push(issue(`${path}.CertificateArn`, "CertificateArn is required"));
      else if (!localCertificate.test(config.CertificateArn)) issues.push(issue(`${path}.CertificateArn`, "CertificateArn must identify an ACM certificate in this account and Region"));
      if (config.OwnershipVerificationCertificateArn !== undefined && (typeof config.OwnershipVerificationCertificateArn !== "string" || !localCertificate.test(config.OwnershipVerificationCertificateArn))) issues.push(issue(`${path}.OwnershipVerificationCertificateArn`, "OwnershipVerificationCertificateArn must identify an ACM certificate in this account and Region", typeof config.OwnershipVerificationCertificateArn === "string" ? "UnsupportedProperty" : "InvalidType"));
      if (config.CertificateName !== undefined && typeof config.CertificateName !== "string") issues.push(issue(`${path}.CertificateName`, "CertificateName must be a string", "InvalidType"));
    }
  }
  if (properties.RoutingMode !== undefined && !["API_MAPPING_ONLY", "ROUTING_RULE_ONLY", "ROUTING_RULE_THEN_API_MAPPING"].includes(properties.RoutingMode)) issues.push(issue("Properties.RoutingMode", "RoutingMode is invalid"));
  if (isObject(properties.MutualTlsAuthentication)) {
    rejectUnknown(properties.MutualTlsAuthentication, "Properties.MutualTlsAuthentication", ["TruststoreUri", "TruststoreVersion"], issues);
    if (typeof properties.MutualTlsAuthentication.TruststoreUri !== "string" || !/^s3:\/\/[A-Za-z0-9.-]+\/.+/.test(properties.MutualTlsAuthentication.TruststoreUri)) issues.push(issue("Properties.MutualTlsAuthentication.TruststoreUri", "TruststoreUri must be an S3 URI"));
    if (properties.MutualTlsAuthentication.TruststoreVersion !== undefined && typeof properties.MutualTlsAuthentication.TruststoreVersion !== "string") issues.push(issue("Properties.MutualTlsAuthentication.TruststoreVersion", "TruststoreVersion must be a string", "InvalidType"));
  }
  return issues;
}

function canonicalDomain(properties: unknown, context?: ProviderContext): ApiGatewayV2DomainNameModel {
  const issues = domainIssues(properties, context); throwIssues(issues); const input = properties as JsonObject;
  const configs = Object.freeze(input.DomainNameConfigurations.map((value: JsonObject) => Object.freeze(canonicalJson({
    ...value, EndpointType: value.EndpointType ?? "REGIONAL", IpAddressType: value.IpAddressType ?? "ipv4", SecurityPolicy: value.SecurityPolicy ?? "TLS_1_2",
  }))));
  return Object.freeze({
    DomainName: String(input.DomainName).toLowerCase().replace(/\.$/, ""), DomainNameConfigurations: configs,
    ...(isObject(input.MutualTlsAuthentication) ? { MutualTlsAuthentication: Object.freeze(canonicalJson(input.MutualTlsAuthentication)) } : {}),
    RoutingMode: input.RoutingMode ?? "API_MAPPING_ONLY", Tags: tags(input.Tags),
  }) as ApiGatewayV2DomainNameModel;
}

function domainInput(model: ApiGatewayV2DomainNameModel): JsonObject {
  return { domainName: model.DomainName, domainNameConfigurations: model.DomainNameConfigurations.map(value => lowerObject(value)), mutualTlsAuthentication: model.MutualTlsAuthentication ? lowerObject(model.MutualTlsAuthentication) : undefined, routingMode: model.RoutingMode, tags: model.Tags };
}

function domainFromRaw(raw: JsonObject): ApiGatewayV2DomainNameModel {
  const configurations = (raw.domainNameConfigurations ?? []).map((value: JsonObject) => {
    const config = upperObject(value) ?? {};
    return Object.freeze(Object.fromEntries(DOMAIN_CONFIGURATION_NAMES.filter(name => config[name] !== undefined).map(name => [name, config[name]])));
  });
  return Object.freeze({
    DomainName: String(raw.domainName), DomainNameConfigurations: Object.freeze(configurations),
    ...(raw.mutualTlsAuthentication ? { MutualTlsAuthentication: Object.freeze(canonicalJson(upperObject(raw.mutualTlsAuthentication))) } : {}),
    RoutingMode: raw.routingMode ?? "API_MAPPING_ONLY", Tags: tags(raw.tags),
  }) as ApiGatewayV2DomainNameModel;
}

async function domainReadModel(service: ApiGatewayV2Service, domainName: string): Promise<ProviderReadModel<ApiGatewayV2DomainNameModel>> {
  const raw = await call<JsonObject>(service, "GET", `/v2/domainnames/${segment(domainName)}`); const config = raw.domainNameConfigurations?.[0] ?? {};
  return { physicalId: String(raw.domainName), properties: domainFromRaw(raw), attributes: { DomainNameArn: String(raw.domainNameArn), RegionalDomainName: String(config.apiGatewayDomainName), RegionalHostedZoneId: String(config.hostedZoneId) } };
}

export function createApiGatewayV2DomainNameProvider(service: ApiGatewayV2Service): ProductionResourceProvider<ApiGatewayV2DomainNameModel> {
  return {
    typeName: API_GATEWAY_V2_DOMAIN_NAME_TYPE, providerVersion: 1, visibility: "production", schema: API_GATEWAY_V2_DOMAIN_NAME_SCHEMA,
    validate(properties, context) { return domainIssues(properties, context); }, canonicalize(properties, context) { return canonicalDomain(properties, context); },
    plan(previous, desired) { return plan(previous, desired, API_GATEWAY_V2_DOMAIN_NAME_SCHEMA, ["DomainName"], (name, before, after) => name === "MutualTlsAuthentication" && before !== undefined && after === undefined); },
    async create(desired, context) {
      try { const raw = await call<JsonObject>(service, "POST", "/v2/domainnames", domainInput(desired), context.idempotencyKey); const model = await domainReadModel(service, String(raw.domainName)); return providerResult(model.physicalId, model); }
      catch (error) { return failure(error); }
    },
    async read(physicalId): Promise<ProviderReadResult<ApiGatewayV2DomainNameModel>> {
      try { const model = await domainReadModel(service, physicalId); return providerResult(physicalId, model); }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); }
    },
    async update(physicalId, previous, desired, context): Promise<ProviderUpdateResult<ApiGatewayV2DomainNameModel>> {
      try {
        if (physicalId !== desired.DomainName || previous.DomainName !== desired.DomainName) throw new AwsError("RequiresReplacement", "DomainName changes require replacement", 409);
        if (previous.MutualTlsAuthentication && !desired.MutualTlsAuthentication) throw new AwsError("RequiresReplacement", "Removing MutualTlsAuthentication requires replacement", 409);
        const input = domainInput(desired); delete input.domainName; delete input.tags;
        await call(service, "PATCH", `/v2/domainnames/${segment(physicalId)}`, input);
        await replaceTags(service, resourceArn(context, `/domainnames/${physicalId}`), previous.Tags, desired.Tags);
        const model = await domainReadModel(service, physicalId); return providerResult(physicalId, model);
      } catch (error) { return failure(error); }
    },
    async delete(physicalId): Promise<ProviderDeleteResult> {
      try { await call(service, "DELETE", `/v2/domainnames/${segment(physicalId)}`); return { status: "SUCCESS", physicalId }; }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); }
    },
    ref(model) { return model.physicalId; }, getAtt(model, attribute) { return getAtt(API_GATEWAY_V2_DOMAIN_NAME_TYPE, API_GATEWAY_V2_DOMAIN_NAME_SCHEMA, model, attribute); },
  };
}

function apiMappingIssues(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_V2_API_MAPPING_SCHEMA);
  if (!isObject(properties)) return issues;
  for (const name of ["ApiId", "DomainName", "Stage"]) validateRequiredString(properties, name, issues);
  if (typeof properties.ApiMappingKey === "string" && properties.ApiMappingKey !== "") {
    const key = properties.ApiMappingKey.replace(/^\/+|\/+$/g, "");
    if (!key || key.length > 300 || key.split("/").some(segment => !/^[A-Za-z0-9$_.+!*'(),:@&=-]+$/.test(segment))) issues.push(issue("Properties.ApiMappingKey", "ApiMappingKey must be a valid path of at most 300 characters"));
  }
  return issues;
}

function canonicalApiMapping(properties: unknown): ApiGatewayV2ApiMappingModel {
  const issues = apiMappingIssues(properties); throwIssues(issues); const input = properties as JsonObject;
  return Object.freeze({ ApiId: String(input.ApiId), ...(optionalString(input.ApiMappingKey) ? { ApiMappingKey: String(input.ApiMappingKey).replace(/^\/+|\/+$/g, "") } : {}), DomainName: String(input.DomainName).toLowerCase().replace(/\.$/, ""), Stage: String(input.Stage) });
}

function apiMappingFromRaw(domainName: string, raw: JsonObject): ApiGatewayV2ApiMappingModel {
  return Object.freeze({ ApiId: String(raw.apiId), ...(optionalString(raw.apiMappingKey) ? { ApiMappingKey: String(raw.apiMappingKey) } : {}), DomainName: domainName, Stage: String(raw.stage) });
}

async function apiMappingReadModel(service: ApiGatewayV2Service, domainName: string, mappingId: string): Promise<ProviderReadModel<ApiGatewayV2ApiMappingModel>> {
  const raw = await call<JsonObject>(service, "GET", `/v2/domainnames/${segment(domainName)}/apimappings/${segment(mappingId)}`);
  return { physicalId: physical("api-mapping", [domainName, mappingId]), properties: apiMappingFromRaw(domainName, raw), attributes: { ApiMappingId: mappingId } };
}

export function createApiGatewayV2ApiMappingProvider(service: ApiGatewayV2Service): ProductionResourceProvider<ApiGatewayV2ApiMappingModel> {
  return {
    typeName: API_GATEWAY_V2_API_MAPPING_TYPE, providerVersion: 1, visibility: "production", schema: API_GATEWAY_V2_API_MAPPING_SCHEMA,
    validate(properties) { return apiMappingIssues(properties); }, canonicalize(properties) { return canonicalApiMapping(properties); },
    plan(previous, desired) { return plan(previous, desired, API_GATEWAY_V2_API_MAPPING_SCHEMA, ["DomainName"]); },
    async create(desired, context) {
      try { const raw = await call<JsonObject>(service, "POST", `/v2/domainnames/${segment(desired.DomainName)}/apimappings`, { apiId: desired.ApiId, apiMappingKey: desired.ApiMappingKey, stage: desired.Stage }, context.idempotencyKey); const model = await apiMappingReadModel(service, desired.DomainName, String(raw.apiMappingId)); return providerResult(model.physicalId, model); }
      catch (error) { return failure(error); }
    },
    async read(physicalId): Promise<ProviderReadResult<ApiGatewayV2ApiMappingModel>> {
      try { const [domainName, mappingId] = parsePhysical(physicalId, "api-mapping", 2); const model = await apiMappingReadModel(service, domainName, mappingId); return providerResult(physicalId, model); }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); }
    },
    async update(physicalId, previous, desired): Promise<ProviderUpdateResult<ApiGatewayV2ApiMappingModel>> {
      try {
        const [domainName, mappingId] = parsePhysical(physicalId, "api-mapping", 2); if (domainName !== desired.DomainName || previous.DomainName !== desired.DomainName) throw new AwsError("RequiresReplacement", "DomainName changes require replacement", 409);
        await call(service, "PATCH", `/v2/domainnames/${segment(domainName)}/apimappings/${segment(mappingId)}`, { apiId: desired.ApiId, apiMappingKey: desired.ApiMappingKey ?? "", stage: desired.Stage });
        const model = await apiMappingReadModel(service, domainName, mappingId); return providerResult(physicalId, model);
      } catch (error) { return failure(error); }
    },
    async delete(physicalId): Promise<ProviderDeleteResult> {
      try { const [domainName, mappingId] = parsePhysical(physicalId, "api-mapping", 2); await call(service, "DELETE", `/v2/domainnames/${segment(domainName)}/apimappings/${segment(mappingId)}`); return { status: "SUCCESS", physicalId }; }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); }
    },
    ref(model) { return String(model.attributes.ApiMappingId); }, getAtt(model, attribute) { return getAtt(API_GATEWAY_V2_API_MAPPING_TYPE, API_GATEWAY_V2_API_MAPPING_SCHEMA, model, attribute); },
  };
}

function modelIssues(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_V2_MODEL_SCHEMA);
  if (!isObject(properties)) return issues;
  for (const name of ["ApiId", "Name"]) validateRequiredString(properties, name, issues);
  if (properties.Schema === undefined) issues.push(issue("Properties.Schema", "Schema must be a JSON value"));
  else { try { const encoded = JSON.stringify(properties.Schema); if (encoded === undefined) throw new Error(); JSON.parse(encoded); } catch { issues.push(issue("Properties.Schema", "Schema must be serializable JSON")); } }
  return issues;
}

function canonicalModel(properties: unknown): ApiGatewayV2ModelModel {
  const issues = modelIssues(properties); throwIssues(issues); const input = properties as JsonObject;
  return Object.freeze({ ApiId: String(input.ApiId), ...(optionalString(input.ContentType) ? { ContentType: String(input.ContentType) } : {}), ...(optionalString(input.Description) ? { Description: String(input.Description) } : {}), Name: String(input.Name).trim(), Schema: canonicalJson(input.Schema) });
}

function modelFromRaw(apiId: string, raw: JsonObject): ApiGatewayV2ModelModel {
  let schema: unknown; try { schema = JSON.parse(String(raw.schema)); } catch { throw new AwsError("InternalFailure", `Model ${String(raw.modelId)} has invalid stored JSON schema`, 500); }
  return Object.freeze({ ApiId: apiId, ...(optionalString(raw.contentType) ? { ContentType: String(raw.contentType) } : {}), ...(optionalString(raw.description) ? { Description: String(raw.description) } : {}), Name: String(raw.name), Schema: canonicalJson(schema) });
}

async function modelReadModel(service: ApiGatewayV2Service, apiId: string, modelId: string): Promise<ProviderReadModel<ApiGatewayV2ModelModel>> {
  const raw = await call<JsonObject>(service, "GET", `/v2/apis/${segment(apiId)}/models/${segment(modelId)}`);
  return { physicalId: physical("model", [apiId, modelId]), properties: modelFromRaw(apiId, raw), attributes: { ModelId: modelId } };
}

export function createApiGatewayV2ModelProvider(service: ApiGatewayV2Service): ProductionResourceProvider<ApiGatewayV2ModelModel> {
  return {
    typeName: API_GATEWAY_V2_MODEL_TYPE, providerVersion: 1, visibility: "production", schema: API_GATEWAY_V2_MODEL_SCHEMA,
    validate(properties) { return modelIssues(properties); }, canonicalize(properties) { return canonicalModel(properties); },
    plan(previous, desired) { return plan(previous, desired, API_GATEWAY_V2_MODEL_SCHEMA, ["ApiId"]); },
    async create(desired, context) {
      try { await requireProtocol(service, desired.ApiId, "WEBSOCKET", API_GATEWAY_V2_MODEL_TYPE); const raw = await call<JsonObject>(service, "POST", `/v2/apis/${segment(desired.ApiId)}/models`, { contentType: desired.ContentType, description: desired.Description, name: desired.Name, schema: JSON.stringify(desired.Schema) }, context.idempotencyKey); const model = await modelReadModel(service, desired.ApiId, String(raw.modelId)); return providerResult(model.physicalId, model); }
      catch (error) { return failure(error); }
    },
    async read(physicalId): Promise<ProviderReadResult<ApiGatewayV2ModelModel>> {
      try { const [apiId, modelId] = parsePhysical(physicalId, "model", 2); const model = await modelReadModel(service, apiId, modelId); return providerResult(physicalId, model); }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); }
    },
    async update(physicalId, previous, desired): Promise<ProviderUpdateResult<ApiGatewayV2ModelModel>> {
      try { const [apiId, modelId] = parsePhysical(physicalId, "model", 2); if (apiId !== desired.ApiId || previous.ApiId !== desired.ApiId) throw new AwsError("RequiresReplacement", "ApiId changes require replacement", 409); await requireProtocol(service, apiId, "WEBSOCKET", API_GATEWAY_V2_MODEL_TYPE); await call(service, "PATCH", `/v2/apis/${segment(apiId)}/models/${segment(modelId)}`, { contentType: desired.ContentType ?? "", description: desired.Description ?? "", name: desired.Name, schema: JSON.stringify(desired.Schema) }); const model = await modelReadModel(service, apiId, modelId); return providerResult(physicalId, model); }
      catch (error) { return failure(error); }
    },
    async delete(physicalId): Promise<ProviderDeleteResult> {
      try { const [apiId, modelId] = parsePhysical(physicalId, "model", 2); await call(service, "DELETE", `/v2/apis/${segment(apiId)}/models/${segment(modelId)}`); return { status: "SUCCESS", physicalId }; }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); }
    },
    ref(model) { return String(model.attributes.ModelId); }, getAtt(model, attribute) { return getAtt(API_GATEWAY_V2_MODEL_TYPE, API_GATEWAY_V2_MODEL_SCHEMA, model, attribute); },
  };
}

function integrationResponseIssues(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_V2_INTEGRATION_RESPONSE_SCHEMA);
  if (!isObject(properties)) return issues;
  for (const name of ["ApiId", "IntegrationId", "IntegrationResponseKey"]) validateRequiredString(properties, name, issues);
  if (properties.ContentHandlingStrategy !== undefined && !["CONVERT_TO_BINARY", "CONVERT_TO_TEXT"].includes(properties.ContentHandlingStrategy)) issues.push(issue("Properties.ContentHandlingStrategy", "ContentHandlingStrategy must be CONVERT_TO_BINARY or CONVERT_TO_TEXT"));
  validateStringMap(properties.ResponseParameters, "Properties.ResponseParameters", issues); validateStringMap(properties.ResponseTemplates, "Properties.ResponseTemplates", issues);
  return issues;
}

function canonicalIntegrationResponse(properties: unknown): ApiGatewayV2IntegrationResponseModel {
  const issues = integrationResponseIssues(properties); throwIssues(issues); const input = properties as JsonObject;
  return Object.freeze({ ApiId: String(input.ApiId), ...(optionalString(input.ContentHandlingStrategy) ? { ContentHandlingStrategy: input.ContentHandlingStrategy } : {}), IntegrationId: String(input.IntegrationId), IntegrationResponseKey: String(input.IntegrationResponseKey), ResponseParameters: stringMap(input.ResponseParameters), ResponseTemplates: stringMap(input.ResponseTemplates), ...(optionalString(input.TemplateSelectionExpression) ? { TemplateSelectionExpression: String(input.TemplateSelectionExpression) } : {}) });
}

function integrationResponseFromRaw(apiId: string, integrationId: string, raw: JsonObject): ApiGatewayV2IntegrationResponseModel {
  return Object.freeze({ ApiId: apiId, ...(optionalString(raw.contentHandlingStrategy) ? { ContentHandlingStrategy: raw.contentHandlingStrategy } : {}), IntegrationId: integrationId, IntegrationResponseKey: String(raw.integrationResponseKey), ResponseParameters: stringMap(raw.responseParameters), ResponseTemplates: stringMap(raw.responseTemplates), ...(optionalString(raw.templateSelectionExpression) ? { TemplateSelectionExpression: String(raw.templateSelectionExpression) } : {}) });
}

async function integrationResponseReadModel(service: ApiGatewayV2Service, apiId: string, integrationId: string, responseId: string): Promise<ProviderReadModel<ApiGatewayV2IntegrationResponseModel>> {
  const raw = await call<JsonObject>(service, "GET", `/v2/apis/${segment(apiId)}/integrations/${segment(integrationId)}/integrationresponses/${segment(responseId)}`);
  return { physicalId: physical("integration-response", [apiId, integrationId, responseId]), properties: integrationResponseFromRaw(apiId, integrationId, raw), attributes: { IntegrationResponseId: responseId } };
}

export function createApiGatewayV2IntegrationResponseProvider(service: ApiGatewayV2Service): ProductionResourceProvider<ApiGatewayV2IntegrationResponseModel> {
  return {
    typeName: API_GATEWAY_V2_INTEGRATION_RESPONSE_TYPE, providerVersion: 1, visibility: "production", schema: API_GATEWAY_V2_INTEGRATION_RESPONSE_SCHEMA,
    validate(properties) { return integrationResponseIssues(properties); }, canonicalize(properties) { return canonicalIntegrationResponse(properties); },
    plan(previous, desired) { return plan(previous, desired, API_GATEWAY_V2_INTEGRATION_RESPONSE_SCHEMA, ["ApiId", "IntegrationId"]); },
    async create(desired, context) {
      try { await requireProtocol(service, desired.ApiId, "WEBSOCKET", API_GATEWAY_V2_INTEGRATION_RESPONSE_TYPE); const raw = await call<JsonObject>(service, "POST", `/v2/apis/${segment(desired.ApiId)}/integrations/${segment(desired.IntegrationId)}/integrationresponses`, { contentHandlingStrategy: desired.ContentHandlingStrategy, integrationResponseKey: desired.IntegrationResponseKey, responseParameters: desired.ResponseParameters, responseTemplates: desired.ResponseTemplates, templateSelectionExpression: desired.TemplateSelectionExpression }, context.idempotencyKey); const model = await integrationResponseReadModel(service, desired.ApiId, desired.IntegrationId, String(raw.integrationResponseId)); return providerResult(model.physicalId, model); }
      catch (error) { return failure(error); }
    },
    async read(physicalId): Promise<ProviderReadResult<ApiGatewayV2IntegrationResponseModel>> {
      try { const [apiId, integrationId, responseId] = parsePhysical(physicalId, "integration-response", 3); const model = await integrationResponseReadModel(service, apiId, integrationId, responseId); return providerResult(physicalId, model); }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); }
    },
    async update(physicalId, previous, desired): Promise<ProviderUpdateResult<ApiGatewayV2IntegrationResponseModel>> {
      try { const [apiId, integrationId, responseId] = parsePhysical(physicalId, "integration-response", 3); if (apiId !== desired.ApiId || integrationId !== desired.IntegrationId || previous.ApiId !== desired.ApiId || previous.IntegrationId !== desired.IntegrationId) throw new AwsError("RequiresReplacement", "ApiId and IntegrationId changes require replacement", 409); await requireProtocol(service, apiId, "WEBSOCKET", API_GATEWAY_V2_INTEGRATION_RESPONSE_TYPE); await call(service, "PATCH", `/v2/apis/${segment(apiId)}/integrations/${segment(integrationId)}/integrationresponses/${segment(responseId)}`, { contentHandlingStrategy: desired.ContentHandlingStrategy ?? "", integrationResponseKey: desired.IntegrationResponseKey, responseParameters: desired.ResponseParameters, responseTemplates: desired.ResponseTemplates, templateSelectionExpression: desired.TemplateSelectionExpression ?? "" }); const model = await integrationResponseReadModel(service, apiId, integrationId, responseId); return providerResult(physicalId, model); }
      catch (error) { return failure(error); }
    },
    async delete(physicalId): Promise<ProviderDeleteResult> {
      try { const [apiId, integrationId, responseId] = parsePhysical(physicalId, "integration-response", 3); await call(service, "DELETE", `/v2/apis/${segment(apiId)}/integrations/${segment(integrationId)}/integrationresponses/${segment(responseId)}`); return { status: "SUCCESS", physicalId }; }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); }
    },
    ref(model) { return String(model.attributes.IntegrationResponseId); }, getAtt(model, attribute) { return getAtt(API_GATEWAY_V2_INTEGRATION_RESPONSE_TYPE, API_GATEWAY_V2_INTEGRATION_RESPONSE_SCHEMA, model, attribute); },
  };
}

function routeResponseIssues(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_V2_ROUTE_RESPONSE_SCHEMA);
  if (!isObject(properties)) return issues;
  for (const name of ["ApiId", "RouteId", "RouteResponseKey"]) validateRequiredString(properties, name, issues);
  if (properties.RouteResponseKey !== undefined && properties.RouteResponseKey !== "$default") issues.push(issue("Properties.RouteResponseKey", "RouteResponseKey must be $default"));
  validateStringMap(properties.ResponseModels, "Properties.ResponseModels", issues); validateParameterConstraints(properties.ResponseParameters, "Properties.ResponseParameters", issues);
  return issues;
}

function canonicalRouteResponse(properties: unknown): ApiGatewayV2RouteResponseModel {
  const issues = routeResponseIssues(properties); throwIssues(issues); const input = properties as JsonObject;
  return Object.freeze({ ApiId: String(input.ApiId), ...(optionalString(input.ModelSelectionExpression) ? { ModelSelectionExpression: String(input.ModelSelectionExpression) } : {}), ResponseModels: stringMap(input.ResponseModels), ResponseParameters: canonicalConstraints(input.ResponseParameters), RouteId: String(input.RouteId), RouteResponseKey: String(input.RouteResponseKey) });
}

function routeResponseFromRaw(apiId: string, routeId: string, raw: JsonObject): ApiGatewayV2RouteResponseModel {
  return Object.freeze({ ApiId: apiId, ...(optionalString(raw.modelSelectionExpression) ? { ModelSelectionExpression: String(raw.modelSelectionExpression) } : {}), ResponseModels: stringMap(raw.responseModels), ResponseParameters: constraintsFromService(raw.responseParameters), RouteId: routeId, RouteResponseKey: String(raw.routeResponseKey) });
}

async function routeResponseReadModel(service: ApiGatewayV2Service, apiId: string, routeId: string, responseId: string): Promise<ProviderReadModel<ApiGatewayV2RouteResponseModel>> {
  const raw = await call<JsonObject>(service, "GET", `/v2/apis/${segment(apiId)}/routes/${segment(routeId)}/routeresponses/${segment(responseId)}`);
  return { physicalId: physical("route-response", [apiId, routeId, responseId]), properties: routeResponseFromRaw(apiId, routeId, raw), attributes: { RouteResponseId: responseId } };
}

export function createApiGatewayV2RouteResponseProvider(service: ApiGatewayV2Service): ProductionResourceProvider<ApiGatewayV2RouteResponseModel> {
  return {
    typeName: API_GATEWAY_V2_ROUTE_RESPONSE_TYPE, providerVersion: 1, visibility: "production", schema: API_GATEWAY_V2_ROUTE_RESPONSE_SCHEMA,
    validate(properties) { return routeResponseIssues(properties); }, canonicalize(properties) { return canonicalRouteResponse(properties); },
    plan(previous, desired) { return plan(previous, desired, API_GATEWAY_V2_ROUTE_RESPONSE_SCHEMA, ["ApiId", "RouteId"]); },
    async create(desired, context) {
      try { await requireProtocol(service, desired.ApiId, "WEBSOCKET", API_GATEWAY_V2_ROUTE_RESPONSE_TYPE); const raw = await call<JsonObject>(service, "POST", `/v2/apis/${segment(desired.ApiId)}/routes/${segment(desired.RouteId)}/routeresponses`, { modelSelectionExpression: desired.ModelSelectionExpression, responseModels: desired.ResponseModels, responseParameters: constraintsToService(desired.ResponseParameters), routeResponseKey: desired.RouteResponseKey }, context.idempotencyKey); const model = await routeResponseReadModel(service, desired.ApiId, desired.RouteId, String(raw.routeResponseId)); return providerResult(model.physicalId, model); }
      catch (error) { return failure(error); }
    },
    async read(physicalId): Promise<ProviderReadResult<ApiGatewayV2RouteResponseModel>> {
      try { const [apiId, routeId, responseId] = parsePhysical(physicalId, "route-response", 3); const model = await routeResponseReadModel(service, apiId, routeId, responseId); return providerResult(physicalId, model); }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); }
    },
    async update(physicalId, previous, desired): Promise<ProviderUpdateResult<ApiGatewayV2RouteResponseModel>> {
      try { const [apiId, routeId, responseId] = parsePhysical(physicalId, "route-response", 3); if (apiId !== desired.ApiId || routeId !== desired.RouteId || previous.ApiId !== desired.ApiId || previous.RouteId !== desired.RouteId) throw new AwsError("RequiresReplacement", "ApiId and RouteId changes require replacement", 409); await requireProtocol(service, apiId, "WEBSOCKET", API_GATEWAY_V2_ROUTE_RESPONSE_TYPE); await call(service, "PATCH", `/v2/apis/${segment(apiId)}/routes/${segment(routeId)}/routeresponses/${segment(responseId)}`, { modelSelectionExpression: desired.ModelSelectionExpression ?? "", responseModels: desired.ResponseModels, responseParameters: constraintsToService(desired.ResponseParameters), routeResponseKey: desired.RouteResponseKey }); const model = await routeResponseReadModel(service, apiId, routeId, responseId); return providerResult(physicalId, model); }
      catch (error) { return failure(error); }
    },
    async delete(physicalId): Promise<ProviderDeleteResult> {
      try { const [apiId, routeId, responseId] = parsePhysical(physicalId, "route-response", 3); await call(service, "DELETE", `/v2/apis/${segment(apiId)}/routes/${segment(routeId)}/routeresponses/${segment(responseId)}`); return { status: "SUCCESS", physicalId }; }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); }
    },
    ref(model) { return String(model.attributes.RouteResponseId); }, getAtt(model, attribute) { return getAtt(API_GATEWAY_V2_ROUTE_RESPONSE_TYPE, API_GATEWAY_V2_ROUTE_RESPONSE_SCHEMA, model, attribute); },
  };
}

/** Exact CFN-12 production provider set. Registration is intentionally left to the application composition root. */
export function createApiGatewayV2CloudFormationProviders(service: ApiGatewayV2Service): readonly ProductionResourceProvider<any>[] {
  return Object.freeze([
    createApiGatewayV2ApiProvider(service), createApiGatewayV2IntegrationProvider(service), createApiGatewayV2RouteProvider(service),
    createApiGatewayV2DeploymentProvider(service), createApiGatewayV2StageProvider(service), createApiGatewayV2AuthorizerProvider(service),
    createApiGatewayV2DomainNameProvider(service), createApiGatewayV2ApiMappingProvider(service), createApiGatewayV2ModelProvider(service),
    createApiGatewayV2IntegrationResponseProvider(service), createApiGatewayV2RouteResponseProvider(service),
  ]);
}
