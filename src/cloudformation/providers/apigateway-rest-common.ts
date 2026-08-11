import { createHash } from "node:crypto";
import type { ApiGatewayService } from "../../apigateway.js";
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

export const API_GATEWAY_AUTHORIZER_TYPE = "AWS::ApiGateway::Authorizer";
export const API_GATEWAY_MODEL_TYPE = "AWS::ApiGateway::Model";
export const API_GATEWAY_REQUEST_VALIDATOR_TYPE = "AWS::ApiGateway::RequestValidator";
export const API_GATEWAY_GATEWAY_RESPONSE_TYPE = "AWS::ApiGateway::GatewayResponse";
export const API_GATEWAY_API_KEY_TYPE = "AWS::ApiGateway::ApiKey";
export const API_GATEWAY_USAGE_PLAN_TYPE = "AWS::ApiGateway::UsagePlan";
export const API_GATEWAY_USAGE_PLAN_KEY_TYPE = "AWS::ApiGateway::UsagePlanKey";

type JsonObject = Record<string, any>;

export interface ApiGatewayAuthorizerModel {
  readonly RestApiId: string;
  readonly Name: string;
  readonly Type: "TOKEN" | "REQUEST" | "COGNITO_USER_POOLS";
  readonly AuthorizerUri?: string;
  readonly AuthorizerCredentials?: string;
  readonly ProviderARNs?: readonly string[];
  readonly IdentitySource?: string;
  readonly IdentityValidationExpression?: string;
  readonly AuthorizerResultTtlInSeconds: number;
}

export interface ApiGatewayModelModel {
  readonly RestApiId: string;
  readonly Name: string;
  readonly ContentType: string;
  readonly Description: string;
  readonly Schema: string;
}

export interface ApiGatewayRequestValidatorModel {
  readonly RestApiId: string;
  readonly Name: string;
  readonly ValidateRequestBody: boolean;
  readonly ValidateRequestParameters: boolean;
}

export interface ApiGatewayGatewayResponseModel {
  readonly RestApiId: string;
  readonly ResponseType: string;
  readonly StatusCode?: string;
  readonly ResponseParameters: Readonly<Record<string, string>>;
  readonly ResponseTemplates: Readonly<Record<string, string>>;
}

export interface ApiGatewayApiKeyModel {
  readonly Name?: string;
  readonly CustomerId?: string;
  readonly Description: string;
  readonly Enabled: boolean;
  readonly Value: string;
  readonly StageKeys: readonly { readonly RestApiId: string; readonly StageName: string }[];
  readonly Tags: readonly { readonly Key: string; readonly Value: string }[];
}

export interface ApiGatewayUsagePlanModel {
  readonly UsagePlanName: string;
  readonly Description: string;
  readonly ApiStages: readonly {
    readonly ApiId: string;
    readonly Stage: string;
    readonly Throttle: Readonly<Record<string, { readonly BurstLimit?: number; readonly RateLimit?: number }>>;
  }[];
  readonly Throttle?: { readonly BurstLimit?: number; readonly RateLimit?: number };
  readonly Quota?: { readonly Limit: number; readonly Offset?: number; readonly Period: "DAY" | "WEEK" | "MONTH" };
  readonly Tags: readonly { readonly Key: string; readonly Value: string }[];
}

export interface ApiGatewayUsagePlanKeyModel {
  readonly KeyId: string;
  readonly KeyType: "API_KEY";
  readonly UsagePlanId: string;
}

const RETENTION = Object.freeze({
  deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
  updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const), snapshotSupported: false,
});
const NO_TAGS = Object.freeze({ behavior: "NONE" as const, propagatesCloudFormationTags: false });
const STACK_TAGS = Object.freeze({ behavior: "STACK_AND_RESOURCE" as const, propertyName: "Tags", propagatesCloudFormationTags: true });

export const API_GATEWAY_AUTHORIZER_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_AUTHORIZER_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    RestApiId: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    Name: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    Type: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    AuthorizerUri: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    AuthorizerCredentials: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    ProviderARNs: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    IdentitySource: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    IdentityValidationExpression: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    AuthorizerResultTtlInSeconds: Object.freeze({ valueType: "number", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string" }), attributes: Object.freeze({ AuthorizerId: Object.freeze({ valueType: "string" }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }), retention: RETENTION, tags: NO_TAGS,
});

export const API_GATEWAY_MODEL_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_MODEL_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    RestApiId: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    Name: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    ContentType: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    Description: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    Schema: Object.freeze({ valueType: "any", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string" }), attributes: Object.freeze({}),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }), retention: RETENTION, tags: NO_TAGS,
});

export const API_GATEWAY_REQUEST_VALIDATOR_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_REQUEST_VALIDATOR_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    RestApiId: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    Name: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    ValidateRequestBody: Object.freeze({ valueType: "boolean", updateBehavior: "MUTABLE" }),
    ValidateRequestParameters: Object.freeze({ valueType: "boolean", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string" }), attributes: Object.freeze({ RequestValidatorId: Object.freeze({ valueType: "string" }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }), retention: RETENTION, tags: NO_TAGS,
});

export const API_GATEWAY_GATEWAY_RESPONSE_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_GATEWAY_RESPONSE_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    RestApiId: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    ResponseType: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    StatusCode: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    ResponseParameters: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    ResponseTemplates: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string" }), attributes: Object.freeze({ Id: Object.freeze({ valueType: "string" }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }), retention: RETENTION, tags: NO_TAGS,
});

export const API_GATEWAY_API_KEY_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_API_KEY_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    Name: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }), CustomerId: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    Description: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }), Enabled: Object.freeze({ valueType: "boolean", updateBehavior: "MUTABLE" }),
    Value: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT", sensitive: true }), StageKeys: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }), Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string" }), attributes: Object.freeze({ APIKeyId: Object.freeze({ valueType: "string" }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }), retention: RETENTION, tags: STACK_TAGS,
});

export const API_GATEWAY_USAGE_PLAN_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_USAGE_PLAN_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    UsagePlanName: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }), Description: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    ApiStages: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }), Throttle: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    Quota: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }), Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string" }), attributes: Object.freeze({ Id: Object.freeze({ valueType: "string" }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }), retention: RETENTION, tags: STACK_TAGS,
});

export const API_GATEWAY_USAGE_PLAN_KEY_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_USAGE_PLAN_KEY_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    KeyId: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    KeyType: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    UsagePlanId: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string" }), attributes: Object.freeze({ Id: Object.freeze({ valueType: "string" }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }), retention: RETENTION, tags: NO_TAGS,
});

const GATEWAY_RESPONSE_TYPES = new Set([
  "ACCESS_DENIED", "API_CONFIGURATION_ERROR", "AUTHORIZER_CONFIGURATION_ERROR", "AUTHORIZER_FAILURE", "BAD_REQUEST_PARAMETERS", "BAD_REQUEST_BODY",
  "DEFAULT_4XX", "DEFAULT_5XX", "EXPIRED_TOKEN", "INTEGRATION_FAILURE", "INTEGRATION_TIMEOUT", "INVALID_API_KEY", "INVALID_SIGNATURE",
  "MISSING_AUTHENTICATION_TOKEN", "QUOTA_EXCEEDED", "REQUEST_TOO_LARGE", "RESOURCE_NOT_FOUND", "THROTTLED", "UNAUTHORIZED", "UNSUPPORTED_MEDIA_TYPE", "WAF_FILTERED",
]);

function isObject(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function canonicalValue(value: any): any { if (Array.isArray(value)) return value.map(canonicalValue); if (!isObject(value)) return value; return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])])); }
function withoutUndefined(value: any): any { if (Array.isArray(value)) return value.map(withoutUndefined); if (!isObject(value)) return value; return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, withoutUndefined(item)])); }
function stringMap(value: unknown): Readonly<Record<string, string>> { return Object.freeze(Object.fromEntries(Object.entries(isObject(value) ? value : {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, String(item)]))); }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function issue(path: string, message: string, code: ProviderValidationIssue["code"] = "InvalidProperty"): ProviderValidationIssue { return { code, path, message }; }
function throwIssues(issues: readonly ProviderValidationIssue[]): void { if (issues.length) throw new TypeError(issues.map(value => `${value.path}: ${value.message}`).join("; ")); }
function failure(error: unknown): ProviderFailed { if (error instanceof AwsError) return { status: "FAILED", errorCode: error.code, message: error.message, ...(error.status >= 500 ? { retryable: true } : {}) }; return { status: "FAILED", errorCode: "InternalFailure", message: error instanceof Error ? error.message : String(error), retryable: true }; }
function isMissing(error: unknown): boolean { return error instanceof AwsError && ["NotFoundException", "ResourceNotFoundException"].includes(error.code); }
async function call<T>(service: ApiGatewayService, method: string, path: string, input?: unknown): Promise<T> { return (await invokeJsonService<T>({ method, path, input, handle: service.handle.bind(service) })).body; }
function segment(value: string): string { return encodeURIComponent(value); }
function physical(kind: string, values: readonly string[]): string { return `stacksim:apigateway:${kind}:${Buffer.from(JSON.stringify(values)).toString("base64url")}`; }
function parsePhysical(value: string, kind: string, length: number): string[] { const prefix = `stacksim:apigateway:${kind}:`; try { const parts = JSON.parse(Buffer.from(value.startsWith(prefix) ? value.slice(prefix.length) : "", "base64url").toString("utf8")); if (!Array.isArray(parts) || parts.length !== length || parts.some(part => typeof part !== "string" || !part)) throw new Error(); return parts; } catch { throw new AwsError("InvalidPhysicalResourceId", `Invalid ${kind} physical resource identifier`, 400); } }
function generated(context: ProviderContext, label: string, max: number, alphanumeric = false): string { const base = context.logicalId.replace(alphanumeric ? /[^A-Za-z0-9]/g : /[^A-Za-z0-9_-]/g, "").slice(0, Math.max(1, max - 13)) || label; const suffix = createHash("sha256").update(`${context.stackId}\0${context.logicalId}\0${label}`).digest("hex").slice(0, 12); return `${base}${alphanumeric ? "" : "-"}${suffix}`.slice(0, max); }
function generatedKeyValue(context: ProviderContext): string { return createHash("sha256").update(`${context.stackId}\0${context.logicalId}\0ApiKey`).digest("hex").padEnd(40, "0").slice(0, 40); }
function plan<Model>(previous: Model | undefined, desired: Model, schema: ProviderSchema, replacements: readonly string[]): ProviderPlan<Model> { const names = Object.keys(schema.properties).sort(); if (!previous) return { action: "CREATE", desired, changedProperties: names.filter(name => !same((desired as any)[name], undefined)), replacementProperties: [] }; const changed = names.filter(name => !same((previous as any)[name], (desired as any)[name])); if (!changed.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] }; const replacementProperties = changed.filter(name => replacements.includes(name)); return replacementProperties.length ? { action: "REPLACE", desired, changedProperties: changed, replacementProperties, replacementOrder: "CREATE_BEFORE_DELETE" } : { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [] }; }
function getAtt(typeName: string, schema: ProviderSchema, model: ProviderReadModel<any>, attribute: string): unknown { if (!Object.hasOwn(schema.attributes, attribute)) throw new ProviderReferenceError(typeName, `Fn::GetAtt ${attribute}`); return model.attributes[attribute]; }
function validateStringMap(value: unknown, path: string, issues: ProviderValidationIssue[]): void { if (!isObject(value)) return; for (const [key, item] of Object.entries(value)) if (typeof item !== "string") issues.push(issue(`${path}.${key}`, `${path}.${key} must be a string`, "InvalidType")); }
function validateTags(value: unknown, issues: ProviderValidationIssue[]): void { if (!Array.isArray(value)) return; if (value.length > 50) issues.push(issue("Properties.Tags", "A resource can have at most 50 tags")); const keys = new Set<string>(); value.forEach((tag, index) => { const path = `Properties.Tags[${index}]`; if (!isObject(tag)) { issues.push(issue(path, `${path} must be an object`, "InvalidType")); return; } for (const key of Object.keys(tag)) if (!["Key", "Value"].includes(key)) issues.push(issue(`${path}.${key}`, `Tag does not support ${key}`, "UnsupportedProperty")); if (typeof tag.Key !== "string" || !tag.Key) issues.push(issue(`${path}.Key`, "Tag Key is required")); else if (keys.has(tag.Key)) issues.push(issue(`${path}.Key`, `Duplicate tag key ${tag.Key}`)); else keys.add(tag.Key); if (typeof tag.Value !== "string") issues.push(issue(`${path}.Value`, "Tag Value must be a string", "InvalidType")); if (typeof tag.Key === "string" && (tag.Key.length > 128 || tag.Key.toLowerCase().startsWith("aws:") || !/^[A-Za-z0-9 +\-=._:/@]*$/.test(tag.Key))) issues.push(issue(`${path}.Key`, "Tag Key is invalid")); if (typeof tag.Value === "string" && (tag.Value.length > 256 || !/^[A-Za-z0-9 +\-=._:/@]*$/.test(tag.Value))) issues.push(issue(`${path}.Value`, "Tag Value is invalid")); }); }
function tags(value: unknown): readonly { readonly Key: string; readonly Value: string }[] { return Object.freeze((Array.isArray(value) ? value : []).map(tag => ({ Key: String(tag.Key), Value: String(tag.Value) })).sort((a, b) => a.Key.localeCompare(b.Key))); }
function tagMap(value: readonly { readonly Key: string; readonly Value: string }[]): Record<string, string> { return Object.fromEntries(value.map(tag => [tag.Key, tag.Value])); }
async function reconcileTags(service: ApiGatewayService, arn: string, current: readonly { readonly Key: string; readonly Value: string }[], desired: readonly { readonly Key: string; readonly Value: string }[]): Promise<void> { const desiredMap = tagMap(desired); const removed = current.map(tag => tag.Key).filter(key => !Object.hasOwn(desiredMap, key)); if (removed.length) { const query = new URLSearchParams(); removed.forEach(key => query.append("tagKeys", key)); await call(service, "DELETE", `/tags/${segment(arn)}?${query.toString()}`); } if (Object.keys(desiredMap).length) await call(service, "PUT", `/tags/${segment(arn)}`, { tags: desiredMap }); }

function authorizerIssues(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_AUTHORIZER_SCHEMA); if (!isObject(properties)) return issues;
  if (properties.Type !== undefined && !["TOKEN", "REQUEST", "COGNITO_USER_POOLS"].includes(properties.Type)) issues.push(issue("Properties.Type", "Type must be TOKEN, REQUEST, or COGNITO_USER_POOLS"));
  const cognito = properties.Type === "COGNITO_USER_POOLS";
  if (!cognito && typeof properties.AuthorizerUri !== "string") issues.push(issue("Properties.AuthorizerUri", "TOKEN and REQUEST authorizers require AuthorizerUri"));
  if (cognito && properties.AuthorizerUri !== undefined) issues.push(issue("Properties.AuthorizerUri", "Cognito authorizers do not accept AuthorizerUri"));
  if (cognito && properties.AuthorizerCredentials !== undefined) issues.push(issue("Properties.AuthorizerCredentials", "Cognito authorizers do not accept AuthorizerCredentials"));
  if (typeof properties.AuthorizerUri === "string" && !/^arn:aws:apigateway:[^:]+:lambda:path\/2015-03-31\/functions\/arn:aws:lambda:[^/]+\/invocations$/.test(properties.AuthorizerUri)) issues.push(issue("Properties.AuthorizerUri", "AuthorizerUri must be an API Gateway Lambda invocation URI"));
  if (cognito && (!Array.isArray(properties.ProviderARNs) || properties.ProviderARNs.length < 1 || properties.ProviderARNs.some(value => typeof value !== "string"))) issues.push(issue("Properties.ProviderARNs", "Cognito authorizers require one or more user-pool ARNs"));
  if (!cognito && properties.ProviderARNs !== undefined) issues.push(issue("Properties.ProviderARNs", "ProviderARNs is valid only for Cognito authorizers"));
  if (typeof properties.AuthorizerResultTtlInSeconds === "number" && (!Number.isInteger(properties.AuthorizerResultTtlInSeconds) || properties.AuthorizerResultTtlInSeconds < 0 || properties.AuthorizerResultTtlInSeconds > 3600)) issues.push(issue("Properties.AuthorizerResultTtlInSeconds", "AuthorizerResultTtlInSeconds must be an integer from 0 through 3600"));
  const ttl = Number(properties.AuthorizerResultTtlInSeconds ?? 300); if ((properties.Type === "TOKEN" || properties.Type === "REQUEST" && ttl > 0 || cognito) && !properties.IdentitySource) issues.push(issue("Properties.IdentitySource", "The authorizer requires IdentitySource"));
  if (typeof properties.IdentityValidationExpression === "string") try { new RegExp(properties.IdentityValidationExpression); } catch { issues.push(issue("Properties.IdentityValidationExpression", "IdentityValidationExpression must be a valid regular expression")); }
  return issues;
}

function canonicalAuthorizer(properties: unknown): ApiGatewayAuthorizerModel { const issues = authorizerIssues(properties); throwIssues(issues); const input = properties as JsonObject; return Object.freeze({ RestApiId: String(input.RestApiId), Name: String(input.Name), Type: input.Type as any, ...(input.AuthorizerUri === undefined ? {} : { AuthorizerUri: String(input.AuthorizerUri) }), ...(input.AuthorizerCredentials === undefined ? {} : { AuthorizerCredentials: String(input.AuthorizerCredentials) }), ...(input.ProviderARNs === undefined ? {} : { ProviderARNs: Object.freeze([...(input.ProviderARNs as unknown[])].map(String).sort()) }), ...(input.IdentitySource === undefined ? {} : { IdentitySource: String(input.IdentitySource) }), ...(input.IdentityValidationExpression === undefined ? {} : { IdentityValidationExpression: String(input.IdentityValidationExpression) }), AuthorizerResultTtlInSeconds: Number(input.AuthorizerResultTtlInSeconds ?? 300) }); }
function authorizerFromRaw(apiId: string, raw: JsonObject): ApiGatewayAuthorizerModel { return canonicalAuthorizer(withoutUndefined({ RestApiId: apiId, Name: raw.name, Type: raw.type, AuthorizerUri: raw.authorizerUri, AuthorizerCredentials: raw.authorizerCredentials, ProviderARNs: raw.providerARNs, IdentitySource: raw.identitySource, IdentityValidationExpression: raw.identityValidationExpression, AuthorizerResultTtlInSeconds: raw.authorizerResultTtlInSeconds })); }
async function readAuthorizer(service: ApiGatewayService, apiId: string, id: string): Promise<ProviderReadModel<ApiGatewayAuthorizerModel>> { const raw = await call<JsonObject>(service, "GET", `/restapis/${segment(apiId)}/authorizers/${segment(id)}`); return { physicalId: physical("authorizer", [apiId, id]), properties: authorizerFromRaw(apiId, raw), attributes: { AuthorizerId: id } }; }

export function createApiGatewayAuthorizerProvider(service: ApiGatewayService): ProductionResourceProvider<ApiGatewayAuthorizerModel> {
  return { typeName: API_GATEWAY_AUTHORIZER_TYPE, providerVersion: 1, visibility: "production", schema: API_GATEWAY_AUTHORIZER_SCHEMA,
    validate(properties) { return authorizerIssues(properties); }, canonicalize(properties) { return canonicalAuthorizer(properties); }, plan(previous, desired) { return plan(previous, desired, API_GATEWAY_AUTHORIZER_SCHEMA, ["RestApiId"]); },
    async create(desired) { try { const raw = await call<JsonObject>(service, "POST", `/restapis/${segment(desired.RestApiId)}/authorizers`, { name: desired.Name, type: desired.Type, authorizerUri: desired.AuthorizerUri, authorizerCredentials: desired.AuthorizerCredentials, providerARNs: desired.ProviderARNs, identitySource: desired.IdentitySource, identityValidationExpression: desired.IdentityValidationExpression, authorizerResultTtlInSeconds: desired.AuthorizerResultTtlInSeconds }); const model = await readAuthorizer(service, desired.RestApiId, String(raw.id)); return { status: "SUCCESS", physicalId: model.physicalId, model }; } catch (error) { return failure(error); } },
    async read(physicalId): Promise<ProviderReadResult<ApiGatewayAuthorizerModel>> { try { const [apiId, id] = parsePhysical(physicalId, "authorizer", 2); return { status: "SUCCESS", physicalId, model: await readAuthorizer(service, apiId, id) }; } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); } },
    async update(physicalId, previous, desired): Promise<ProviderUpdateResult<ApiGatewayAuthorizerModel>> { try { const [apiId, id] = parsePhysical(physicalId, "authorizer", 2); if (apiId !== desired.RestApiId || previous.RestApiId !== desired.RestApiId) throw new AwsError("RequiresReplacement", "RestApiId changes require replacement", 409); const mapping: [string, unknown][] = [["name", desired.Name], ["type", desired.Type], ["authorizerUri", desired.AuthorizerUri], ["authorizerCredentials", desired.AuthorizerCredentials], ["identitySource", desired.IdentitySource], ["identityValidationExpression", desired.IdentityValidationExpression], ["authorizerResultTtlInSeconds", desired.AuthorizerResultTtlInSeconds]]; const beforeArns = new Set(previous.ProviderARNs ?? []); const afterArns = new Set(desired.ProviderARNs ?? []); const providerPatches = [...beforeArns].filter(value => !afterArns.has(value)).map(value => ({ op: "remove", path: "/providerARNs", value })).concat([...afterArns].filter(value => !beforeArns.has(value)).map(value => ({ op: "add", path: "/providerARNs", value }))); await call(service, "PATCH", `/restapis/${segment(apiId)}/authorizers/${segment(id)}`, { patchOperations: [...mapping.map(([name, value]) => value === undefined ? { op: "remove", path: `/${name}` } : { op: "replace", path: `/${name}`, value }), ...providerPatches] }); const model = await readAuthorizer(service, apiId, id); return { status: "SUCCESS", physicalId, model }; } catch (error) { return failure(error); } },
    async delete(physicalId): Promise<ProviderDeleteResult> { try { const [apiId, id] = parsePhysical(physicalId, "authorizer", 2); await call(service, "DELETE", `/restapis/${segment(apiId)}/authorizers/${segment(id)}`); return { status: "SUCCESS", physicalId }; } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); } },
    ref(model) { return String(model.attributes.AuthorizerId); }, getAtt(model, attribute) { return getAtt(API_GATEWAY_AUTHORIZER_TYPE, API_GATEWAY_AUTHORIZER_SCHEMA, model, attribute); },
  };
}

function modelIssues(properties: unknown): ProviderValidationIssue[] { const issues = validateDeclaredProperties(properties, API_GATEWAY_MODEL_SCHEMA); if (!isObject(properties)) return issues; if (typeof properties.Name === "string" && !/^[A-Za-z0-9]+$/.test(properties.Name)) issues.push(issue("Properties.Name", "Name must contain only alphanumeric characters")); if (typeof properties.ContentType === "string" && !/^[^\s/]+\/[^\s/]+$/.test(properties.ContentType)) issues.push(issue("Properties.ContentType", "ContentType must be a media type")); if (properties.Schema !== undefined) { try { const schema = typeof properties.Schema === "string" ? JSON.parse(properties.Schema) : properties.Schema; if (!isObject(schema)) throw new Error(); } catch { issues.push(issue("Properties.Schema", "Schema must be an object or JSON object string")); } } return issues; }
function canonicalModel(properties: unknown, context: ProviderContext): ApiGatewayModelModel { const issues = modelIssues(properties); throwIssues(issues); const input = properties as JsonObject; const schema = input.Schema === undefined ? {} : typeof input.Schema === "string" ? JSON.parse(input.Schema) : input.Schema; return Object.freeze({ RestApiId: String(input.RestApiId), Name: String(input.Name ?? generated(context, "Model", 128, true)), ContentType: String(input.ContentType ?? "application/json").toLowerCase(), Description: String(input.Description ?? ""), Schema: JSON.stringify(canonicalValue(schema)) }); }
async function readModel(service: ApiGatewayService, apiId: string, name: string): Promise<ProviderReadModel<ApiGatewayModelModel>> { const raw = await call<JsonObject>(service, "GET", `/restapis/${segment(apiId)}/models/${segment(name)}`); return { physicalId: physical("model", [apiId, name]), properties: { RestApiId: apiId, Name: String(raw.name), ContentType: String(raw.contentType), Description: String(raw.description ?? ""), Schema: String(raw.schema ?? "{}") }, attributes: {} }; }

export function createApiGatewayModelProvider(service: ApiGatewayService): ProductionResourceProvider<ApiGatewayModelModel> {
  return { typeName: API_GATEWAY_MODEL_TYPE, providerVersion: 1, visibility: "production", schema: API_GATEWAY_MODEL_SCHEMA,
    validate(properties) { return modelIssues(properties); }, canonicalize(properties, context) { return canonicalModel(properties, context); }, plan(previous, desired) { return plan(previous, desired, API_GATEWAY_MODEL_SCHEMA, ["RestApiId", "Name", "ContentType"]); },
    async create(desired) { try { await call(service, "POST", `/restapis/${segment(desired.RestApiId)}/models`, { name: desired.Name, contentType: desired.ContentType, description: desired.Description, schema: desired.Schema }); const model = await readModel(service, desired.RestApiId, desired.Name); return { status: "SUCCESS", physicalId: model.physicalId, model }; } catch (error) { return failure(error); } },
    async read(physicalId): Promise<ProviderReadResult<ApiGatewayModelModel>> { try { const [apiId, name] = parsePhysical(physicalId, "model", 2); return { status: "SUCCESS", physicalId, model: await readModel(service, apiId, name) }; } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); } },
    async update(physicalId, previous, desired): Promise<ProviderUpdateResult<ApiGatewayModelModel>> { try { const [apiId, name] = parsePhysical(physicalId, "model", 2); if (apiId !== desired.RestApiId || name !== desired.Name || previous.RestApiId !== desired.RestApiId || previous.Name !== desired.Name || previous.ContentType !== desired.ContentType) throw new AwsError("RequiresReplacement", "RestApiId, Name, and ContentType changes require replacement", 409); await call(service, "PATCH", `/restapis/${segment(apiId)}/models/${segment(name)}`, { patchOperations: [{ op: "replace", path: "/description", value: desired.Description }, { op: "replace", path: "/schema", value: desired.Schema }] }); const model = await readModel(service, apiId, name); return { status: "SUCCESS", physicalId, model }; } catch (error) { return failure(error); } },
    async delete(physicalId): Promise<ProviderDeleteResult> { try { const [apiId, name] = parsePhysical(physicalId, "model", 2); await call(service, "DELETE", `/restapis/${segment(apiId)}/models/${segment(name)}`); return { status: "SUCCESS", physicalId }; } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); } },
    ref(model) { return model.properties.Name; }, getAtt(model, attribute) { return getAtt(API_GATEWAY_MODEL_TYPE, API_GATEWAY_MODEL_SCHEMA, model, attribute); },
  };
}

function validatorIssues(properties: unknown): ProviderValidationIssue[] { const issues = validateDeclaredProperties(properties, API_GATEWAY_REQUEST_VALIDATOR_SCHEMA); if (isObject(properties) && typeof properties.Name === "string" && !properties.Name.trim()) issues.push(issue("Properties.Name", "Name must not be empty")); return issues; }
function canonicalValidator(properties: unknown, context: ProviderContext): ApiGatewayRequestValidatorModel { const issues = validatorIssues(properties); throwIssues(issues); const input = properties as JsonObject; return Object.freeze({ RestApiId: String(input.RestApiId), Name: String(input.Name ?? generated(context, "Validator", 128)), ValidateRequestBody: Boolean(input.ValidateRequestBody ?? false), ValidateRequestParameters: Boolean(input.ValidateRequestParameters ?? false) }); }
async function readValidator(service: ApiGatewayService, apiId: string, id: string): Promise<ProviderReadModel<ApiGatewayRequestValidatorModel>> { const raw = await call<JsonObject>(service, "GET", `/restapis/${segment(apiId)}/requestvalidators/${segment(id)}`); return { physicalId: physical("request-validator", [apiId, id]), properties: { RestApiId: apiId, Name: String(raw.name ?? ""), ValidateRequestBody: Boolean(raw.validateRequestBody), ValidateRequestParameters: Boolean(raw.validateRequestParameters) }, attributes: { RequestValidatorId: id } }; }

export function createApiGatewayRequestValidatorProvider(service: ApiGatewayService): ProductionResourceProvider<ApiGatewayRequestValidatorModel> {
  return { typeName: API_GATEWAY_REQUEST_VALIDATOR_TYPE, providerVersion: 1, visibility: "production", schema: API_GATEWAY_REQUEST_VALIDATOR_SCHEMA,
    validate(properties) { return validatorIssues(properties); }, canonicalize(properties, context) { return canonicalValidator(properties, context); }, plan(previous, desired) { return plan(previous, desired, API_GATEWAY_REQUEST_VALIDATOR_SCHEMA, ["RestApiId", "Name"]); },
    async create(desired) { try { const raw = await call<JsonObject>(service, "POST", `/restapis/${segment(desired.RestApiId)}/requestvalidators`, { name: desired.Name, validateRequestBody: desired.ValidateRequestBody, validateRequestParameters: desired.ValidateRequestParameters }); const model = await readValidator(service, desired.RestApiId, String(raw.id)); return { status: "SUCCESS", physicalId: model.physicalId, model }; } catch (error) { return failure(error); } },
    async read(physicalId): Promise<ProviderReadResult<ApiGatewayRequestValidatorModel>> { try { const [apiId, id] = parsePhysical(physicalId, "request-validator", 2); return { status: "SUCCESS", physicalId, model: await readValidator(service, apiId, id) }; } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); } },
    async update(physicalId, previous, desired): Promise<ProviderUpdateResult<ApiGatewayRequestValidatorModel>> { try { const [apiId, id] = parsePhysical(physicalId, "request-validator", 2); if (apiId !== desired.RestApiId || previous.RestApiId !== desired.RestApiId || previous.Name !== desired.Name) throw new AwsError("RequiresReplacement", "RestApiId and Name changes require replacement", 409); await call(service, "PATCH", `/restapis/${segment(apiId)}/requestvalidators/${segment(id)}`, { patchOperations: [{ op: "replace", path: "/validateRequestBody", value: desired.ValidateRequestBody }, { op: "replace", path: "/validateRequestParameters", value: desired.ValidateRequestParameters }] }); const model = await readValidator(service, apiId, id); return { status: "SUCCESS", physicalId, model }; } catch (error) { return failure(error); } },
    async delete(physicalId): Promise<ProviderDeleteResult> { try { const [apiId, id] = parsePhysical(physicalId, "request-validator", 2); await call(service, "DELETE", `/restapis/${segment(apiId)}/requestvalidators/${segment(id)}`); return { status: "SUCCESS", physicalId }; } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); } },
    ref(model) { return String(model.attributes.RequestValidatorId); }, getAtt(model, attribute) { return getAtt(API_GATEWAY_REQUEST_VALIDATOR_TYPE, API_GATEWAY_REQUEST_VALIDATOR_SCHEMA, model, attribute); },
  };
}

function gatewayResponseIssues(properties: unknown): ProviderValidationIssue[] { const issues = validateDeclaredProperties(properties, API_GATEWAY_GATEWAY_RESPONSE_SCHEMA); if (!isObject(properties)) return issues; if (properties.ResponseType !== undefined && !GATEWAY_RESPONSE_TYPES.has(String(properties.ResponseType))) issues.push(issue("Properties.ResponseType", "ResponseType is not supported by API Gateway REST")); if (properties.StatusCode !== undefined && (typeof properties.StatusCode !== "string" || !/^\d{3}$/.test(properties.StatusCode))) issues.push(issue("Properties.StatusCode", "StatusCode must contain three digits")); validateStringMap(properties.ResponseParameters, "Properties.ResponseParameters", issues); validateStringMap(properties.ResponseTemplates, "Properties.ResponseTemplates", issues); return issues; }
function canonicalGatewayResponse(properties: unknown): ApiGatewayGatewayResponseModel { const issues = gatewayResponseIssues(properties); throwIssues(issues); const input = properties as JsonObject; return Object.freeze({ RestApiId: String(input.RestApiId), ResponseType: String(input.ResponseType), ...(input.StatusCode === undefined ? {} : { StatusCode: String(input.StatusCode) }), ResponseParameters: stringMap(input.ResponseParameters), ResponseTemplates: stringMap(input.ResponseTemplates) }); }
async function rawGatewayResponse(service: ApiGatewayService, apiId: string, responseType: string): Promise<JsonObject> { return call(service, "GET", `/restapis/${segment(apiId)}/gatewayresponses/${segment(responseType)}`); }
function gatewayResponseModel(apiId: string, raw: JsonObject): ApiGatewayGatewayResponseModel { return { RestApiId: apiId, ResponseType: String(raw.responseType), ...(raw.statusCode === undefined ? {} : { StatusCode: String(raw.statusCode) }), ResponseParameters: stringMap(raw.responseParameters), ResponseTemplates: stringMap(raw.responseTemplates) }; }

export function createApiGatewayGatewayResponseProvider(service: ApiGatewayService): ProductionResourceProvider<ApiGatewayGatewayResponseModel> {
  return { typeName: API_GATEWAY_GATEWAY_RESPONSE_TYPE, providerVersion: 1, visibility: "production", schema: API_GATEWAY_GATEWAY_RESPONSE_SCHEMA,
    validate(properties) { return gatewayResponseIssues(properties); }, canonicalize(properties) { return canonicalGatewayResponse(properties); }, plan(previous, desired) { return plan(previous, desired, API_GATEWAY_GATEWAY_RESPONSE_SCHEMA, ["RestApiId", "ResponseType"]); },
    async create(desired) { try { const current = await rawGatewayResponse(service, desired.RestApiId, desired.ResponseType); if (!current.defaultResponse) return { status: "FAILED", errorCode: "ConflictException", message: `Gateway response ${desired.ResponseType} is already customized` }; await call(service, "PUT", `/restapis/${segment(desired.RestApiId)}/gatewayresponses/${segment(desired.ResponseType)}`, { statusCode: desired.StatusCode, responseParameters: desired.ResponseParameters, responseTemplates: desired.ResponseTemplates }); const raw = await rawGatewayResponse(service, desired.RestApiId, desired.ResponseType); const id = `${desired.RestApiId}:${desired.ResponseType}`; const physicalId = physical("gateway-response", [desired.RestApiId, desired.ResponseType]); return { status: "SUCCESS", physicalId, model: { physicalId, properties: gatewayResponseModel(desired.RestApiId, raw), attributes: { Id: id } } }; } catch (error) { return failure(error); } },
    async read(physicalId): Promise<ProviderReadResult<ApiGatewayGatewayResponseModel>> { try { const [apiId, responseType] = parsePhysical(physicalId, "gateway-response", 2); const raw = await rawGatewayResponse(service, apiId, responseType); if (raw.defaultResponse) return { status: "NOT_FOUND", physicalId }; return { status: "SUCCESS", physicalId, model: { physicalId, properties: gatewayResponseModel(apiId, raw), attributes: { Id: `${apiId}:${responseType}` } } }; } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); } },
    async update(physicalId, previous, desired): Promise<ProviderUpdateResult<ApiGatewayGatewayResponseModel>> { try { const [apiId, responseType] = parsePhysical(physicalId, "gateway-response", 2); if (apiId !== desired.RestApiId || responseType !== desired.ResponseType || previous.RestApiId !== desired.RestApiId || previous.ResponseType !== desired.ResponseType) throw new AwsError("RequiresReplacement", "RestApiId and ResponseType changes require replacement", 409); await call(service, "PUT", `/restapis/${segment(apiId)}/gatewayresponses/${segment(responseType)}`, { statusCode: desired.StatusCode, responseParameters: desired.ResponseParameters, responseTemplates: desired.ResponseTemplates }); const raw = await rawGatewayResponse(service, apiId, responseType); return { status: "SUCCESS", physicalId, model: { physicalId, properties: gatewayResponseModel(apiId, raw), attributes: { Id: `${apiId}:${responseType}` } } }; } catch (error) { return failure(error); } },
    async delete(physicalId): Promise<ProviderDeleteResult> { try { const [apiId, responseType] = parsePhysical(physicalId, "gateway-response", 2); const raw = await rawGatewayResponse(service, apiId, responseType); if (raw.defaultResponse) return { status: "NOT_FOUND", physicalId }; await call(service, "DELETE", `/restapis/${segment(apiId)}/gatewayresponses/${segment(responseType)}`); return { status: "SUCCESS", physicalId }; } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); } },
    ref(model) { return model.attributes.Id; }, getAtt(model, attribute) { return getAtt(API_GATEWAY_GATEWAY_RESPONSE_TYPE, API_GATEWAY_GATEWAY_RESPONSE_SCHEMA, model, attribute); },
  };
}

function apiKeyIssues(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_API_KEY_SCHEMA); if (!isObject(properties)) return issues;
  if (typeof properties.Name === "string" && !properties.Name.trim()) issues.push(issue("Properties.Name", "Name must not be empty"));
  if (typeof properties.Value === "string" && !/^[A-Za-z0-9]{20,128}$/.test(properties.Value)) issues.push(issue("Properties.Value", "Value must contain 20 to 128 alphanumeric characters"));
  if (Array.isArray(properties.StageKeys)) {
    const identities = new Set<string>();
    properties.StageKeys.forEach((stage, index) => {
      const path = `Properties.StageKeys[${index}]`;
      if (!isObject(stage)) { issues.push(issue(path, "StageKey must be an object", "InvalidType")); return; }
      for (const key of Object.keys(stage)) if (!new Set(["RestApiId", "StageName"]).has(key)) issues.push(issue(`${path}.${key}`, `StageKey does not support ${key}`, "UnsupportedProperty"));
      if (typeof stage.RestApiId !== "string" || !stage.RestApiId) issues.push(issue(`${path}.RestApiId`, "RestApiId is required"));
      if (typeof stage.StageName !== "string" || !stage.StageName) issues.push(issue(`${path}.StageName`, "StageName is required"));
      const identity = `${stage.RestApiId}/${stage.StageName}`; if (identities.has(identity)) issues.push(issue(path, `Duplicate stage key ${identity}`)); else identities.add(identity);
    });
  }
  validateTags(properties.Tags, issues); return issues;
}
function canonicalStageKeys(value: unknown): readonly { readonly RestApiId: string; readonly StageName: string }[] { return Object.freeze((Array.isArray(value) ? value : []).map(stage => Object.freeze({ RestApiId: String(stage.RestApiId), StageName: String(stage.StageName) })).sort((a, b) => `${a.RestApiId}/${a.StageName}`.localeCompare(`${b.RestApiId}/${b.StageName}`))); }
function canonicalApiKey(properties: unknown, context: ProviderContext): ApiGatewayApiKeyModel { const issues = apiKeyIssues(properties); throwIssues(issues); const input = properties as JsonObject; return Object.freeze({ ...(input.Name === undefined ? {} : { Name: String(input.Name) }), ...(input.CustomerId === undefined ? {} : { CustomerId: String(input.CustomerId) }), Description: String(input.Description ?? ""), Enabled: Boolean(input.Enabled ?? false), Value: String(input.Value ?? generatedKeyValue(context)), StageKeys: canonicalStageKeys(input.StageKeys), Tags: tags(input.Tags) }); }
function apiKeyFromRaw(raw: JsonObject): ApiGatewayApiKeyModel { return { ...(raw.name === undefined ? {} : { Name: String(raw.name) }), ...(raw.customerId === undefined ? {} : { CustomerId: String(raw.customerId) }), Description: String(raw.description ?? ""), Enabled: Boolean(raw.enabled), Value: String(raw.value), StageKeys: canonicalStageKeys((raw.stageKeys ?? []).map((value: unknown) => { const token = String(value); const separator = token.indexOf("/"); return { RestApiId: separator < 0 ? token : token.slice(0, separator), StageName: separator < 0 ? "" : token.slice(separator + 1) }; })), Tags: tags(Object.entries(raw.tags ?? {}).map(([Key, Value]) => ({ Key, Value: String(Value) }))) }; }
async function readApiKey(service: ApiGatewayService, id: string): Promise<ProviderReadModel<ApiGatewayApiKeyModel>> { const raw = await call<JsonObject>(service, "GET", `/apikeys/${segment(id)}?includeValue=true`); return { physicalId: id, properties: apiKeyFromRaw(raw), attributes: { APIKeyId: id } }; }

export function createApiGatewayApiKeyProvider(service: ApiGatewayService): ProductionResourceProvider<ApiGatewayApiKeyModel> {
  return { typeName: API_GATEWAY_API_KEY_TYPE, providerVersion: 1, visibility: "production", schema: API_GATEWAY_API_KEY_SCHEMA,
    validate(properties) { return apiKeyIssues(properties); }, canonicalize(properties, context) { return canonicalApiKey(properties, context); }, plan(previous, desired) { return plan(previous, desired, API_GATEWAY_API_KEY_SCHEMA, ["Name", "Value"]); },
    async create(desired) { try { const list = await call<JsonObject>(service, "GET", "/apikeys?includeValues=true&limit=500"); const existing = (list.item ?? []).find((value: JsonObject) => value.value === desired.Value || desired.Name && value.name === desired.Name); if (existing) { const model = await readApiKey(service, String(existing.id)); if (same(model.properties, desired)) return { status: "SUCCESS", physicalId: model.physicalId, model }; return { status: "FAILED", errorCode: "ConflictException", message: `An API key already uses the requested ${existing.value === desired.Value ? "value" : "name"}` }; } const raw = await call<JsonObject>(service, "POST", "/apikeys", { name: desired.Name, customerId: desired.CustomerId, description: desired.Description, enabled: desired.Enabled, value: desired.Value, stageKeys: desired.StageKeys.map(stage => ({ restApiId: stage.RestApiId, stageName: stage.StageName })), tags: tagMap(desired.Tags) }); const model = await readApiKey(service, String(raw.id)); return { status: "SUCCESS", physicalId: model.physicalId, model }; } catch (error) { return failure(error); } },
    async read(physicalId): Promise<ProviderReadResult<ApiGatewayApiKeyModel>> { try { return { status: "SUCCESS", physicalId, model: await readApiKey(service, physicalId) }; } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); } },
    async update(physicalId, previous, desired, context): Promise<ProviderUpdateResult<ApiGatewayApiKeyModel>> { try { if (previous.Name !== desired.Name || previous.Value !== desired.Value) throw new AwsError("RequiresReplacement", "Name and Value changes require replacement", 409); const current = (await readApiKey(service, physicalId)).properties; const fields: [string, unknown][] = [["customerId", desired.CustomerId], ["description", desired.Description], ["enabled", desired.Enabled]]; const currentStages = new Set(current.StageKeys.map(stage => `${stage.RestApiId}/${stage.StageName}`)); const desiredStages = new Set(desired.StageKeys.map(stage => `${stage.RestApiId}/${stage.StageName}`)); const stagePatches = [...currentStages].filter(stage => !desiredStages.has(stage)).map(value => ({ op: "remove", path: "/stages", value })).concat([...desiredStages].filter(stage => !currentStages.has(stage)).map(value => ({ op: "add", path: "/stages", value }))); await call(service, "PATCH", `/apikeys/${segment(physicalId)}`, { patchOperations: [...fields.map(([name, value]) => value === undefined ? { op: "remove", path: `/${name}` } : { op: "replace", path: `/${name}`, value }), ...stagePatches] }); const arn = `arn:${context.partition}:apigateway:${context.region}::/apikeys/${physicalId}`; await reconcileTags(service, arn, current.Tags, desired.Tags); const model = await readApiKey(service, physicalId); return { status: "SUCCESS", physicalId, model }; } catch (error) { return failure(error); } },
    async delete(physicalId): Promise<ProviderDeleteResult> { try { await call(service, "DELETE", `/apikeys/${segment(physicalId)}`); return { status: "SUCCESS", physicalId }; } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); } },
    ref(model) { return model.physicalId; }, getAtt(model, attribute) { return getAtt(API_GATEWAY_API_KEY_TYPE, API_GATEWAY_API_KEY_SCHEMA, model, attribute); },
  };
}

function throttleIssues(value: unknown, path: string, issues: ProviderValidationIssue[]): void { if (!isObject(value)) return; for (const key of Object.keys(value)) if (!["BurstLimit", "RateLimit"].includes(key)) issues.push(issue(`${path}.${key}`, `Throttle does not support ${key}`, "UnsupportedProperty")); if (value.BurstLimit !== undefined && (typeof value.BurstLimit !== "number" || !Number.isInteger(value.BurstLimit) || value.BurstLimit < 0)) issues.push(issue(`${path}.BurstLimit`, "BurstLimit must be a non-negative integer")); if (value.RateLimit !== undefined && (typeof value.RateLimit !== "number" || !Number.isFinite(value.RateLimit) || value.RateLimit < 0)) issues.push(issue(`${path}.RateLimit`, "RateLimit must be non-negative")); }
function usagePlanIssues(properties: unknown): ProviderValidationIssue[] { const issues = validateDeclaredProperties(properties, API_GATEWAY_USAGE_PLAN_SCHEMA); if (!isObject(properties)) return issues; if (typeof properties.UsagePlanName === "string" && (!properties.UsagePlanName || properties.UsagePlanName.length > 1024)) issues.push(issue("Properties.UsagePlanName", "UsagePlanName must contain 1 to 1024 characters")); throttleIssues(properties.Throttle, "Properties.Throttle", issues); if (isObject(properties.Quota)) { for (const key of Object.keys(properties.Quota)) if (!["Limit", "Offset", "Period"].includes(key)) issues.push(issue(`Properties.Quota.${key}`, `Quota does not support ${key}`, "UnsupportedProperty")); if (typeof properties.Quota.Limit !== "number" || !Number.isInteger(properties.Quota.Limit) || properties.Quota.Limit <= 0) issues.push(issue("Properties.Quota.Limit", "Quota Limit must be a positive integer")); if (properties.Quota.Period === undefined || !["DAY", "WEEK", "MONTH"].includes(properties.Quota.Period)) issues.push(issue("Properties.Quota.Period", "Quota Period must be DAY, WEEK, or MONTH")); if (properties.Quota.Offset !== undefined && (typeof properties.Quota.Offset !== "number" || !Number.isInteger(properties.Quota.Offset) || properties.Quota.Offset < 0 || typeof properties.Quota.Limit === "number" && properties.Quota.Offset >= properties.Quota.Limit)) issues.push(issue("Properties.Quota.Offset", "Quota Offset must be a non-negative integer below Limit")); }
  if (Array.isArray(properties.ApiStages)) { const identities = new Set<string>(); properties.ApiStages.forEach((stage, index) => { const path = `Properties.ApiStages[${index}]`; if (!isObject(stage)) { issues.push(issue(path, `${path} must be an object`, "InvalidType")); return; } for (const key of Object.keys(stage)) if (!["ApiId", "Stage", "Throttle"].includes(key)) issues.push(issue(`${path}.${key}`, `ApiStage does not support ${key}`, "UnsupportedProperty")); for (const key of ["ApiId", "Stage"]) if (typeof stage[key] !== "string" || !stage[key]) issues.push(issue(`${path}.${key}`, `${key} is required`)); const identity = `${stage.ApiId}:${stage.Stage}`; if (identities.has(identity)) issues.push(issue(path, "Duplicate API stage")); else identities.add(identity); if (isObject(stage.Throttle)) for (const [method, settings] of Object.entries(stage.Throttle)) { if (!/^\/.*\/[A-Z*]+$/.test(method)) issues.push(issue(`${path}.Throttle.${method}`, "Method throttle keys must be /resource/HTTPMETHOD")); throttleIssues(settings, `${path}.Throttle.${method}`, issues); } }); }
  validateTags(properties.Tags, issues); return issues; }
function canonicalThrottle(value: unknown): { readonly BurstLimit?: number; readonly RateLimit?: number } | undefined { if (!isObject(value)) return undefined; return Object.freeze({ ...(value.BurstLimit === undefined ? {} : { BurstLimit: Number(value.BurstLimit) }), ...(value.RateLimit === undefined ? {} : { RateLimit: Number(value.RateLimit) }) }); }
function serviceThrottle(value: { readonly BurstLimit?: number; readonly RateLimit?: number } | undefined): JsonObject | undefined { return value ? { burstLimit: value.BurstLimit, rateLimit: value.RateLimit } : undefined; }
function canonicalUsagePlan(properties: unknown, context: ProviderContext): ApiGatewayUsagePlanModel { const issues = usagePlanIssues(properties); throwIssues(issues); const input = properties as JsonObject; const quota = input.Quota as JsonObject | undefined; return Object.freeze({ UsagePlanName: String(input.UsagePlanName ?? generated(context, "UsagePlan", 1024)), Description: String(input.Description ?? ""), ApiStages: Object.freeze([...(input.ApiStages ?? [])].map((stage: JsonObject) => Object.freeze({ ApiId: String(stage.ApiId), Stage: String(stage.Stage), Throttle: Object.freeze(Object.fromEntries(Object.entries(stage.Throttle ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonicalThrottle(value)!]))) })).sort((a, b) => `${a.ApiId}:${a.Stage}`.localeCompare(`${b.ApiId}:${b.Stage}`))), ...(input.Throttle === undefined ? {} : { Throttle: canonicalThrottle(input.Throttle) }), ...(quota === undefined ? {} : { Quota: Object.freeze({ Limit: Number(quota.Limit), ...(quota.Offset === undefined ? {} : { Offset: Number(quota.Offset) }), Period: quota.Period as any }) }), Tags: tags(input.Tags) }); }
function serviceApiStages(value: ApiGatewayUsagePlanModel["ApiStages"]): JsonObject[] { return value.map(stage => ({ apiId: stage.ApiId, stage: stage.Stage, ...(Object.keys(stage.Throttle).length ? { throttle: Object.fromEntries(Object.entries(stage.Throttle).map(([key, throttle]) => [key, serviceThrottle(throttle)])) } : {}) })); }
function usagePlanFromRaw(raw: JsonObject): ApiGatewayUsagePlanModel {
  const apiStages = (raw.apiStages ?? []).map((stage: JsonObject) => Object.freeze({ ApiId: String(stage.apiId), Stage: String(stage.stage), Throttle: Object.freeze(Object.fromEntries(Object.entries(stage.throttle ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, throttle]: [string, any]) => [key, Object.freeze({ ...(throttle.burstLimit === undefined ? {} : { BurstLimit: Number(throttle.burstLimit) }), ...(throttle.rateLimit === undefined ? {} : { RateLimit: Number(throttle.rateLimit) }) })]))) })).sort((a: any, b: any) => `${a.ApiId}:${a.Stage}`.localeCompare(`${b.ApiId}:${b.Stage}`));
  return Object.freeze({
    UsagePlanName: String(raw.name), Description: String(raw.description ?? ""), ApiStages: Object.freeze(apiStages),
    ...(raw.throttle === undefined ? {} : { Throttle: canonicalThrottle({ BurstLimit: raw.throttle.burstLimit, RateLimit: raw.throttle.rateLimit }) }),
    ...(raw.quota === undefined ? {} : { Quota: Object.freeze({ Limit: Number(raw.quota.limit), ...(raw.quota.offset === undefined ? {} : { Offset: Number(raw.quota.offset) }), Period: raw.quota.period as "DAY" | "WEEK" | "MONTH" }) }),
    Tags: tags(Object.entries(raw.tags ?? {}).map(([Key, Value]) => ({ Key, Value: String(Value) }))),
  });
}
async function readUsagePlan(service: ApiGatewayService, id: string): Promise<ProviderReadModel<ApiGatewayUsagePlanModel>> { const raw = await call<JsonObject>(service, "GET", `/usageplans/${segment(id)}`); return { physicalId: id, properties: usagePlanFromRaw(raw), attributes: { Id: id } }; }

export function createApiGatewayUsagePlanProvider(service: ApiGatewayService): ProductionResourceProvider<ApiGatewayUsagePlanModel> {
  return { typeName: API_GATEWAY_USAGE_PLAN_TYPE, providerVersion: 1, visibility: "production", schema: API_GATEWAY_USAGE_PLAN_SCHEMA,
    validate(properties) { return usagePlanIssues(properties); }, canonicalize(properties, context) { return canonicalUsagePlan(properties, context); }, plan(previous, desired) { return plan(previous, desired, API_GATEWAY_USAGE_PLAN_SCHEMA, []); },
    async create(desired) { try { const raw = await call<JsonObject>(service, "POST", "/usageplans", { name: desired.UsagePlanName, description: desired.Description, apiStages: serviceApiStages(desired.ApiStages), throttle: serviceThrottle(desired.Throttle), quota: desired.Quota ? { limit: desired.Quota.Limit, offset: desired.Quota.Offset, period: desired.Quota.Period } : undefined, tags: tagMap(desired.Tags) }); const model = await readUsagePlan(service, String(raw.id)); return { status: "SUCCESS", physicalId: model.physicalId, model }; } catch (error) { return failure(error); } },
    async read(physicalId): Promise<ProviderReadResult<ApiGatewayUsagePlanModel>> { try { return { status: "SUCCESS", physicalId, model: await readUsagePlan(service, physicalId) }; } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); } },
    async update(physicalId, _previous, desired, context): Promise<ProviderUpdateResult<ApiGatewayUsagePlanModel>> { try { const current = (await readUsagePlan(service, physicalId)).properties; const patches = [{ op: "replace", path: "/name", value: desired.UsagePlanName }, { op: "replace", path: "/description", value: desired.Description }, { op: "replace", path: "/apiStages", value: serviceApiStages(desired.ApiStages) }, desired.Throttle ? { op: "replace", path: "/throttle", value: serviceThrottle(desired.Throttle) } : { op: "remove", path: "/throttle" }, desired.Quota ? { op: "replace", path: "/quota", value: { limit: desired.Quota.Limit, offset: desired.Quota.Offset, period: desired.Quota.Period } } : { op: "remove", path: "/quota" }]; await call(service, "PATCH", `/usageplans/${segment(physicalId)}`, { patchOperations: patches }); await reconcileTags(service, `arn:${context.partition}:apigateway:${context.region}::/usageplans/${physicalId}`, current.Tags, desired.Tags); const model = await readUsagePlan(service, physicalId); return { status: "SUCCESS", physicalId, model }; } catch (error) { return failure(error); } },
    async delete(physicalId): Promise<ProviderDeleteResult> { try { await call(service, "DELETE", `/usageplans/${segment(physicalId)}`); return { status: "SUCCESS", physicalId }; } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); } },
    ref(model) { return model.physicalId; }, getAtt(model, attribute) { return getAtt(API_GATEWAY_USAGE_PLAN_TYPE, API_GATEWAY_USAGE_PLAN_SCHEMA, model, attribute); },
  };
}

function usagePlanKeyIssues(properties: unknown): ProviderValidationIssue[] { const issues = validateDeclaredProperties(properties, API_GATEWAY_USAGE_PLAN_KEY_SCHEMA); if (isObject(properties) && properties.KeyType !== undefined && properties.KeyType !== "API_KEY") issues.push(issue("Properties.KeyType", "KeyType must be API_KEY")); return issues; }
function canonicalUsagePlanKey(properties: unknown): ApiGatewayUsagePlanKeyModel { const issues = usagePlanKeyIssues(properties); throwIssues(issues); const input = properties as JsonObject; return Object.freeze({ KeyId: String(input.KeyId), KeyType: "API_KEY" as const, UsagePlanId: String(input.UsagePlanId) }); }
async function readUsagePlanKey(service: ApiGatewayService, planId: string, keyId: string): Promise<ProviderReadModel<ApiGatewayUsagePlanKeyModel>> { const raw = await call<JsonObject>(service, "GET", `/usageplans/${segment(planId)}/keys/${segment(keyId)}`); const physicalId = physical("usage-plan-key", [planId, keyId]); return { physicalId, properties: { KeyId: String(raw.id), KeyType: "API_KEY", UsagePlanId: planId }, attributes: { Id: String(raw.id) } }; }

export function createApiGatewayUsagePlanKeyProvider(service: ApiGatewayService): ProductionResourceProvider<ApiGatewayUsagePlanKeyModel> {
  return { typeName: API_GATEWAY_USAGE_PLAN_KEY_TYPE, providerVersion: 1, visibility: "production", schema: API_GATEWAY_USAGE_PLAN_KEY_SCHEMA,
    validate(properties) { return usagePlanKeyIssues(properties); }, canonicalize(properties) { return canonicalUsagePlanKey(properties); }, plan(previous, desired) { return plan(previous, desired, API_GATEWAY_USAGE_PLAN_KEY_SCHEMA, ["KeyId", "KeyType", "UsagePlanId"]); },
    async create(desired) { try { await call(service, "POST", `/usageplans/${segment(desired.UsagePlanId)}/keys`, { keyId: desired.KeyId, keyType: desired.KeyType }); const model = await readUsagePlanKey(service, desired.UsagePlanId, desired.KeyId); return { status: "SUCCESS", physicalId: model.physicalId, model }; } catch (error) { return failure(error); } },
    async read(physicalId): Promise<ProviderReadResult<ApiGatewayUsagePlanKeyModel>> { try { const [planId, keyId] = parsePhysical(physicalId, "usage-plan-key", 2); return { status: "SUCCESS", physicalId, model: await readUsagePlanKey(service, planId, keyId) }; } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); } },
    async update(physicalId, previous, desired): Promise<ProviderUpdateResult<ApiGatewayUsagePlanKeyModel>> { if (!same(previous, desired)) return { status: "FAILED", errorCode: "RequiresReplacement", message: "UsagePlanId, KeyId, and KeyType changes require replacement" }; try { const [planId, keyId] = parsePhysical(physicalId, "usage-plan-key", 2); const model = await readUsagePlanKey(service, planId, keyId); return { status: "SUCCESS", physicalId, model }; } catch (error) { return isMissing(error) ? { status: "FAILED", errorCode: "NotFoundException", message: "Usage plan key association was not found" } : failure(error); } },
    async delete(physicalId): Promise<ProviderDeleteResult> { try { const [planId, keyId] = parsePhysical(physicalId, "usage-plan-key", 2); await call(service, "DELETE", `/usageplans/${segment(planId)}/keys/${segment(keyId)}`); return { status: "SUCCESS", physicalId }; } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : failure(error); } },
    ref(model) { return `${model.properties.KeyId}:${model.properties.UsagePlanId}`; }, getAtt(model, attribute) { return getAtt(API_GATEWAY_USAGE_PLAN_KEY_TYPE, API_GATEWAY_USAGE_PLAN_KEY_SCHEMA, model, attribute); },
  };
}

export function createApiGatewayRestCommonCloudFormationProviders(service: ApiGatewayService): readonly ProductionResourceProvider<any>[] {
  return Object.freeze([
    createApiGatewayAuthorizerProvider(service), createApiGatewayModelProvider(service), createApiGatewayRequestValidatorProvider(service),
    createApiGatewayGatewayResponseProvider(service), createApiGatewayApiKeyProvider(service), createApiGatewayUsagePlanProvider(service), createApiGatewayUsagePlanKeyProvider(service),
  ]);
}
