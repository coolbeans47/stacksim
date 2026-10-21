import { eventError, fnSub, isIntrinsic, isNoValue, isObject, pythonStr, resourceError, SamInvalidDocument, templateError, type JsonObject } from "./common.js";
import { normalizeMethod, X_ANY_METHOD, X_INTEGRATION } from "./swagger.js";

/**
 * The REST API definition edits SAM's SwaggerEditor makes for `Auth`, `Cors`,
 * `Models`, resource policies, and per-method auth, request models, and
 * request parameters, plus SAM's REST authorizer model.
 */

const ALL_HTTP_METHODS = ["OPTIONS", "GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"];
const EXCLUDED_PATH_FIELDS = new Set(["summary", "description", "parameters"]);
export const X_POLICY = "x-amazon-apigateway-policy";

/** InvalidDocumentException([InvalidTemplateException(message)]). */
export const documentError = (message: string) => new SamInvalidDocument([templateError(message)]);

export type ExpectedType = "map" | "list" | "string" | "integer" | "boolean";

function matches(type: ExpectedType, value: unknown): boolean {
  switch (type) {
    case "map": return isObject(value);
    case "list": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "integer": return typeof value === "boolean" || Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
  }
}

/** sam_expect(value, id, keyPath).to_be_a(type): a resource error, or an event error for `event`. */
export function expect(value: unknown, id: string, keyPath: string, type: ExpectedType, event = false, message?: string): void {
  if (matches(type, value)) return;
  const text = message || `Property '${keyPath}' should be a ${type}.`;
  throw event ? eventError(id, text) : resourceError(id, text);
}

// --- SwaggerEditor traversal --------------------------------------------------------

/** BaseEditor.get_conditional_contents: both branches of an Fn::If, without AWS::NoValue. */
export function conditionalContents(item: unknown): unknown[] {
  if (isObject(item) && Object.hasOwn(item, "Fn::If")) {
    const parameters = item["Fn::If"];
    if (!Array.isArray(parameters)) throw documentError("Value of Fn::If must be a list.");
    return parameters.slice(1).filter(content => !isNoValue(content));
  }
  return [item];
}

export function validateIsDict(value: unknown, message: string): asserts value is JsonObject {
  if (!isObject(value)) throw documentError(message);
}

const validatePathItem = (item: unknown, path: string): JsonObject => { validateIsDict(item, `Value of '${path}' path must be a dictionary according to Swagger spec.`); return item; };
const validateMethod = (definition: unknown, path: string, method: string): JsonObject => { validateIsDict(definition, `Definition of method '${method}' for path '${path}' should be a map.`); return definition; };
const hasMethodIntegration = (definition: JsonObject): boolean => Boolean(definition[X_INTEGRATION]);

export const paths = (body: JsonObject): JsonObject => body.paths as JsonObject;

/** SwaggerEditor.__init__: every path item (and both branches of a conditional one) is a map. */
export function validatePaths(body: JsonObject): void {
  for (const [path, item] of Object.entries(paths(body))) for (const content of conditionalContents(item)) validatePathItem(content, path);
}

/** iter_on_all_methods_for_path: (normalized method, definition) pairs, by default only those with an integration. */
export function* methodsForPath(body: JsonObject, path: string, withIntegrationOnly = true): Generator<[string, JsonObject]> {
  for (const item of conditionalContents(paths(body)[path])) {
    const pathItem = validatePathItem(item, path);
    for (const [methodName, method] of Object.entries(pathItem)) {
      if (EXCLUDED_PATH_FIELDS.has(methodName)) continue;
      for (const raw of conditionalContents(method)) {
        const definition = validateMethod(raw, path, methodName);
        if (withIntegrationOnly && !hasMethodIntegration(definition)) continue;
        yield [normalizeMethod(methodName) as string, definition];
      }
    }
  }
}

/** iter_on_method_definitions_for_path_at_method. */
export function* methodDefinitions(body: JsonObject, path: string, method: string, withIntegrationOnly = true): Generator<JsonObject> {
  const normalized = normalizeMethod(method) as string;
  for (const item of conditionalContents(paths(body)[path])) {
    const pathItem = validatePathItem(item, path);
    for (const raw of conditionalContents(pathItem[normalized])) {
      const definition = validateMethod(raw, path, method);
      if (withIntegrationOnly && !hasMethodIntegration(definition)) continue;
      yield definition;
    }
  }
}

function securityList(definition: JsonObject, path: string, method: string): JsonObject[] {
  // method_definition.get("security", []): a present null value is not a list.
  const security = Object.hasOwn(definition, "security") ? definition.security : [];
  if (!Array.isArray(security)) throw documentError(`Type of security for path ${path} method ${method} must be a list`);
  return security as JsonObject[];
}

/** The securityDefinitions map SAM edits; it is written back only when nonempty. */
function securityDefinitions(body: JsonObject): JsonObject {
  return body.securityDefinitions ? body.securityDefinitions as JsonObject : {};
}

function writeSecurityDefinitions(body: JsonObject, definitions: JsonObject): void {
  if (Object.keys(definitions).length) body.securityDefinitions = definitions;
}

/** add_awsiam_security_definition (idempotent). */
export function addAwsIamSecurityDefinition(body: JsonObject): void {
  const definitions = securityDefinitions(body);
  if (!Object.hasOwn(definitions, "AWS_IAM")) definitions.AWS_IAM = { "x-amazon-apigateway-authtype": "awsSigv4", type: "apiKey", name: "Authorization", in: "header" };
  writeSecurityDefinitions(body, definitions);
}

/** add_apikey_security_definition (idempotent). */
export function addApiKeySecurityDefinition(body: JsonObject): void {
  const definitions = securityDefinitions(body);
  if (!isObject(definitions)) throw documentError("securityDefinitions must be a dictionary.");
  if (!Object.hasOwn(definitions, "api_key")) definitions.api_key = { type: "apiKey", name: "x-api-key", in: "header" };
  writeSecurityDefinitions(body, definitions);
}

// --- REST authorizers (ApiGatewayAuthorizer) --------------------------------------------

export interface RestAuthorizer {
  readonly name: string;
  readonly userPoolArn?: unknown;
  readonly functionArn?: unknown;
  readonly identity?: unknown;
  readonly functionPayloadType?: unknown;
  readonly functionInvokeRole?: unknown;
  readonly isAwsIam: boolean;
  readonly authorizationScopes: unknown;
  readonly disableFunctionDefaultPermissions?: unknown;
}

const pythonValue = (value: unknown): string => value === undefined || value === null ? "None" : String(value);

function missingIdentitySource(apiId: string, name: string, identity: unknown): boolean {
  if (!identity || (isObject(identity) && !Object.keys(identity).length)) return true;
  expect(identity, apiId, `Authorizer.${name}.Identity`, "map");
  const value = identity as JsonObject;
  const missing = !value.Headers && !value.QueryStrings && !value.StageVariables && !value.Context;
  const ttl = value.ReauthorizeEvery;
  if (ttl === undefined || ttl === null) return missing;
  const parsed = typeof ttl === "number" ? Math.trunc(ttl) : typeof ttl === "string" && /^\s*[-+]?\d+\s*$/.test(ttl) ? Number.parseInt(ttl, 10) : typeof ttl === "boolean" ? Number(ttl) : Number.NaN;
  if (Number.isNaN(parsed)) return missing;
  return parsed > 0 && missing;
}

/** ApiGatewayAuthorizer.__init__ with its validations. */
export function restAuthorizer(apiId: string, name: string, config: JsonObject | undefined, isAwsIam = false): RestAuthorizer {
  const payloadType = config?.FunctionPayloadType;
  if (payloadType !== undefined && payloadType !== null && payloadType !== "TOKEN" && payloadType !== "REQUEST") throw resourceError(apiId, `${name} Authorizer has invalid 'FunctionPayloadType': ${pythonValue(payloadType)}.`);
  if (payloadType === "REQUEST" && missingIdentitySource(apiId, name, config?.Identity)) throw resourceError(apiId, `${name} Authorizer must specify Identity with at least one of Headers, QueryStrings, StageVariables, or Context.`);
  const scopes = config?.AuthorizationScopes ?? [];
  expect(scopes, apiId, `Authorizers.${name}.AuthorizationScopes`, "list");
  const disable = config?.DisableFunctionDefaultPermissions;
  if (disable !== undefined && disable !== null) expect(disable, apiId, `Authorizers.${name}.DisableFunctionDefaultPermissions`, "boolean");
  return {
    name,
    userPoolArn: config?.UserPoolArn,
    functionArn: config?.FunctionArn,
    identity: config?.Identity,
    functionPayloadType: payloadType,
    functionInvokeRole: config?.FunctionInvokeRole,
    isAwsIam,
    authorizationScopes: scopes,
    disableFunctionDefaultPermissions: disable,
  };
}

const authorizerType = (authorizer: RestAuthorizer): "AWS_IAM" | "COGNITO_USER_POOLS" | "LAMBDA" => authorizer.isAwsIam ? "AWS_IAM" : authorizer.userPoolArn ? "COGNITO_USER_POOLS" : "LAMBDA";
const payloadType = (authorizer: RestAuthorizer): unknown => authorizer.functionPayloadType ? authorizer.functionPayloadType : "TOKEN";

function identityHeader(apiId: string, authorizer: RestAuthorizer): unknown {
  if (authorizer.identity && !isObject(authorizer.identity)) throw resourceError(apiId, "Auth.Authorizers.<Authorizer>.Identity must be a dict (LambdaTokenAuthorizationIdentity, LambdaRequestAuthorizationIdentity or CognitoAuthorizationIdentity).");
  const identity = authorizer.identity as JsonObject | undefined;
  return identity?.Header ? identity.Header : "Authorization";
}

function identitySource(apiId: string, authorizer: RestAuthorizer): string {
  const identity = authorizer.identity as JsonObject;
  const items: string[] = [];
  for (const [key, prefix] of [["Headers", "method.request.header."], ["QueryStrings", "method.request.querystring."], ["StageVariables", "stageVariables."], ["Context", "context."]] as const) {
    const values = identity[key];
    if (!values) continue;
    const propertyPath = `Auth.Authorizers.${authorizer.name}.Identity.${key}`;
    expect(values, apiId, propertyPath, "list");
    (values as unknown[]).forEach((value, index) => { expect(value, apiId, `${propertyPath}[${index}]`, "string"); items.push(`${prefix}${value as string}`); });
  }
  return items.join(", ");
}

/** ApiGatewayAuthorizer.generate_swagger: the securityDefinitions entry. */
export function authorizerSwagger(apiId: string, authorizer: RestAuthorizer, partition: string): JsonObject {
  const type = authorizerType(authorizer);
  const swagger: JsonObject = {
    type: "apiKey",
    name: type === "LAMBDA" && payloadType(authorizer) === "REQUEST" ? "Unused" : identityHeader(apiId, authorizer),
    in: "header",
    "x-amazon-apigateway-authtype": type === "AWS_IAM" ? "awsSigv4" : type === "COGNITO_USER_POOLS" ? "cognito_user_pools" : "custom",
  };
  if (type === "COGNITO_USER_POOLS") {
    swagger["x-amazon-apigateway-authorizer"] = { type: "cognito_user_pools", providerARNs: Array.isArray(authorizer.userPoolArn) ? authorizer.userPoolArn : [authorizer.userPoolArn] };
  } else if (type === "LAMBDA") {
    const extension: JsonObject = { type: payloadType(authorizer) === "REQUEST" ? "request" : payloadType(authorizer) === "TOKEN" ? "token" : null };
    extension.authorizerUri = fnSub(`arn:${partition}:apigateway:\${AWS::Region}:lambda:path/2015-03-31/functions/\${__FunctionArn__}/invocations`, { __FunctionArn__: authorizer.functionArn ?? null });
    const identity = isObject(authorizer.identity) ? authorizer.identity : undefined;
    if (identity && identity.ReauthorizeEvery !== undefined && identity.ReauthorizeEvery !== null) extension.authorizerResultTtlInSeconds = identity.ReauthorizeEvery;
    if (authorizer.functionInvokeRole && authorizer.functionInvokeRole !== "NONE") extension.authorizerCredentials = authorizer.functionInvokeRole;
    if (payloadType(authorizer) === "REQUEST") {
      const source = identitySource(apiId, authorizer);
      if (source) extension.identitySource = source;
    }
    swagger["x-amazon-apigateway-authorizer"] = extension;
  }
  if (type === "COGNITO_USER_POOLS" || (type === "LAMBDA" && payloadType(authorizer) === "TOKEN")) {
    const expression = isObject(authorizer.identity) ? authorizer.identity.ValidationExpression : undefined;
    if (expression) (swagger["x-amazon-apigateway-authorizer"] as JsonObject).identityValidationExpression = expression;
  }
  return swagger;
}

/** ApiGenerator._get_authorizers. */
export function restAuthorizers(apiId: string, config: unknown, defaultAuthorizer?: unknown): Record<string, RestAuthorizer> | undefined {
  const authorizers: Record<string, RestAuthorizer> = {};
  if (defaultAuthorizer === "AWS_IAM") authorizers.AWS_IAM = restAuthorizer(apiId, "AWS_IAM", undefined, true);
  if (!config || (isObject(config) && !Object.keys(config).length)) return Object.hasOwn(authorizers, "AWS_IAM") ? authorizers : undefined;
  expect(config, apiId, "Auth.Authorizers", "map");
  for (const [name, authorizer] of Object.entries(config as JsonObject)) {
    expect(authorizer, apiId, `Auth.Authorizers.${name}`, "map");
    authorizers[name] = restAuthorizer(apiId, name, authorizer as JsonObject);
  }
  return authorizers;
}

const authorizationScopes = (authorizers: Record<string, RestAuthorizer>, name: string): unknown => authorizers[name] ? authorizers[name].authorizationScopes : [];

/** set_path_default_authorizer. */
export function setPathDefaultAuthorizer(body: JsonObject, path: string, defaultAuthorizer: string, authorizers: Record<string, RestAuthorizer>, addToPreflight: boolean): void {
  for (const [methodName, definition] of methodsForPath(body, path)) {
    if (!(addToPreflight || methodName !== "options")) continue;
    const authorizerNames = new Set(["AWS_IAM", ...Object.keys(authorizers)]);
    const existing = securityList(definition, path, methodName);
    const nonAuthorizer: JsonObject[] = [];
    const authorizer: JsonObject[] = [];
    for (const security of existing) {
      validateIsDict(security, `${pythonStr(security)} in Security for path ${path} method ${methodName} is not a valid dictionary.`);
      (Object.keys(security).some(key => authorizerNames.has(key)) ? authorizer : nonAuthorizer).push(security);
    }
    const noneIndex = nonAuthorizer.findIndex(security => Object.hasOwn(security, "NONE"));
    let chosen: JsonObject[] = [];
    if (noneIndex > -1) nonAuthorizer.splice(noneIndex, 1);
    else if (authorizer.length) chosen = authorizer;
    else chosen = [{ [defaultAuthorizer]: authorizationScopes(authorizers, defaultAuthorizer) }];
    const security = [...nonAuthorizer, ...chosen];
    if (security.length) {
      definition.security = security;
      if (Object.hasOwn(security[0], "AWS_IAM")) addAwsIamSecurityDefinition(body);
    }
  }
}

/** set_path_default_apikey_required. */
export function setPathDefaultApiKeyRequired(body: JsonObject, path: string, requiredForOptions: boolean): void {
  for (const [methodName, definition] of methodsForPath(body, path)) {
    const existing = securityList(definition, path, methodName);
    const other: JsonObject[] = [];
    const apiKey: JsonObject[] = [];
    for (const security of existing) {
      validateIsDict(security, `${pythonStr(security)} in Security for path ${path} method ${methodName} is not a valid dictionary.`);
      (Object.hasOwn(security, "api_key") || Object.hasOwn(security, "api_key_false") ? apiKey : other).push(security);
    }
    const falseIndex = apiKey.findIndex(security => Object.hasOwn(security, "api_key_false"));
    let chosen: JsonObject[] = [];
    if (falseIndex > -1) apiKey.splice(falseIndex, 1);
    else chosen = [{ api_key: [] }];
    let security = [...other, ...chosen];
    if (methodName === "options" && !requiredForOptions) security = other;
    if (JSON.stringify(security) !== JSON.stringify(existing)) definition.security = security;
  }
}

/** add_auth_to_method: per-method Authorizer and ApiKeyRequired. */
export function addAuthToMethod(body: JsonObject, path: string, methodName: string, auth: JsonObject, api: JsonObject): void {
  const methodAuthorizer = auth.Authorizer;
  const apiAuth = isObject(api.Auth) ? api.Auth : undefined;
  const authorizers = apiAuth?.Authorizers;
  if (methodAuthorizer) {
    for (const definition of methodDefinitions(body, path, methodName)) {
      const entry: JsonObject = { [methodAuthorizer as string]: [] };
      const security = [...securityList(definition, path, methodName), entry];
      if (methodAuthorizer !== "NONE" && authorizers && (!isObject(authorizers) || Object.keys(authorizers).length)) {
        const authorizer = isObject(authorizers) ? authorizers[methodAuthorizer as string] ?? {} : {};
        if (!isObject(authorizer)) throw documentError(`Type of authorizer '${String(methodAuthorizer)}' must be a dictionary`);
        let scopes = authorizer.AuthorizationScopes;
        if (auth.AuthorizationScopes !== undefined && auth.AuthorizationScopes !== null) scopes = auth.AuthorizationScopes;
        if (isObject(authorizers) && authorizers[methodAuthorizer as string] !== undefined && authorizers[methodAuthorizer as string] !== null && scopes !== undefined && scopes !== null) entry[methodAuthorizer as string] = scopes;
      }
      definition.security = security;
      if (Object.hasOwn(security[0], "AWS_IAM")) addAwsIamSecurityDefinition(body);
    }
  }
  const apiKeyRequired = auth.ApiKeyRequired;
  if (apiKeyRequired !== undefined && apiKeyRequired !== null) {
    for (const definition of methodDefinitions(body, path, methodName)) {
      const entry: JsonObject = apiKeyRequired ? { api_key: [] } : { api_key_false: [] };
      if (apiKeyRequired) addApiKeySecurityDefinition(body);
      definition.security = [...securityList(definition, path, methodName), entry];
    }
  }
}

// --- CORS ---------------------------------------------------------------------------

/** _make_cors_allowed_methods_for_path_item. */
function corsAllowedMethods(pathItem: JsonObject): string {
  const methods = Object.keys(pathItem);
  const allowed = methods.includes(X_ANY_METHOD) ? ALL_HTTP_METHODS : [...methods, "options"];
  return [...new Set(allowed.map(method => method.toUpperCase()))].sort().join(",");
}

/** _options_method_response_for_cors: the OPTIONS mock integration. */
function corsOptionsMethod(origins: unknown, headers: unknown, methods: unknown, maxAge: unknown, credentials: boolean): JsonObject {
  const header = (name: string) => `method.response.header.${name}`;
  const parameters: JsonObject = { [header("Access-Control-Allow-Origin")]: origins };
  const responseHeaders: JsonObject = { "Access-Control-Allow-Origin": { type: "string" } };
  if (headers) { parameters[header("Access-Control-Allow-Headers")] = headers; responseHeaders["Access-Control-Allow-Headers"] = { type: "string" }; }
  if (methods) { parameters[header("Access-Control-Allow-Methods")] = methods; responseHeaders["Access-Control-Allow-Methods"] = { type: "string" }; }
  if (maxAge !== undefined && maxAge !== null) { parameters[header("Access-Control-Max-Age")] = maxAge; responseHeaders["Access-Control-Max-Age"] = { type: "integer" }; }
  if (credentials === true) { parameters[header("Access-Control-Allow-Credentials")] = "'true'"; responseHeaders["Access-Control-Allow-Credentials"] = { type: "string" }; }
  return {
    summary: "CORS support",
    consumes: ["application/json"],
    produces: ["application/json"],
    [X_INTEGRATION]: {
      type: "mock",
      requestTemplates: { "application/json": "{\n  \"statusCode\" : 200\n}\n" },
      responses: { default: { statusCode: "200", responseParameters: parameters, responseTemplates: { "application/json": "{}\n" } } },
    },
    responses: { 200: { description: "Default response for CORS method", headers: responseHeaders } },
  };
}

/** SwaggerEditor.add_cors for one path: an OPTIONS mock unless the path already has OPTIONS. */
export function addCors(body: JsonObject, path: string, origins: unknown, headers: unknown, methods: unknown, maxAge: unknown, credentials: unknown): void {
  let allowedMethods = methods;
  for (const item of conditionalContents(paths(body)[path])) {
    const pathItem = validatePathItem(item, path);
    if (Object.hasOwn(pathItem, "options")) continue;
    if (!origins) throw new CorsError("Invalid input. Value for AllowedOrigins is required");
    if (!allowedMethods) allowedMethods = `'${corsAllowedMethods(pathItem)}'`;
    pathItem.options = corsOptionsMethod(origins, headers, allowedMethods, maxAge, credentials === true);
  }
}

/** An InvalidTemplateException that ApiGenerator._add_cors reports against the API. */
export class CorsError extends Error {}

// --- Resource policies ---------------------------------------------------------------

/** _get_method_path_uri_list: `execute-api:/${__Stage__}/<METHOD><path>` for every method key of the path. */
function methodPathUris(body: JsonObject, path: string, stage: unknown): JsonObject[] {
  const methods: string[] = [];
  for (const item of conditionalContents(paths(body)[path])) methods.push(...Object.keys(validatePathItem(item, path)));
  const trimmed = path.replace(/\{([a-zA-Z0-9._-]+|[a-zA-Z0-9._-]+\+|proxy\+)\}/g, "*");
  return methods.map(method => fnSub(`execute-api:/\${__Stage__}/${method.toLowerCase() === X_ANY_METHOD || method.toLowerCase() === "any" ? "*" : method.toUpperCase()}${trimmed}`, { __Stage__: stage ?? null }));
}

const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function policy(body: JsonObject): JsonObject {
  return isObject(body[X_POLICY]) && Object.keys(body[X_POLICY] as JsonObject).length ? body[X_POLICY] as JsonObject : {};
}

function appendStatements(resourcePolicy: JsonObject, statements: JsonObject[], dedupe: boolean): void {
  if (resourcePolicy.Statement === undefined || resourcePolicy.Statement === null) { resourcePolicy.Statement = statements.length === 1 && !dedupe ? statements[0] : statements; return; }
  const existing = Array.isArray(resourcePolicy.Statement) ? resourcePolicy.Statement : [resourcePolicy.Statement];
  for (const statement of statements) if (!dedupe || !existing.some(item => sameJson(item, statement))) existing.push(statement);
  resourcePolicy.Statement = existing;
}

function iamStatement(resourcePolicy: JsonObject, accounts: unknown, effect: "Allow" | "Deny", resources: JsonObject[]): void {
  if (!accounts || (Array.isArray(accounts) && !accounts.length)) return;
  if (!isObject(accounts) && !Array.isArray(accounts)) throw documentError(`Type of '${pythonStr(accounts)}' must be a list or dictionary`);
  resourcePolicy.Version = "2012-10-17";
  appendStatements(resourcePolicy, [{ Effect: effect, Action: "execute-api:Invoke", Resource: resources, Principal: { AWS: Array.isArray(accounts) ? accounts : [accounts] } }], false);
}

function ipStatements(resourcePolicy: JsonObject, ranges: unknown, conditional: "IpAddress" | "NotIpAddress", resources: JsonObject[]): void {
  if (!ranges || (Array.isArray(ranges) && !ranges.length)) return;
  resourcePolicy.Version = "2012-10-17";
  const allow = { Effect: "Allow", Action: "execute-api:Invoke", Resource: resources, Principal: "*" };
  const deny = { ...allow, Effect: "Deny", Condition: { [conditional]: { "aws:SourceIp": Array.isArray(ranges) ? ranges : [ranges] } } };
  appendStatements(resourcePolicy, [allow, deny], true);
}

function vpcStatements(resourcePolicy: JsonObject, endpoints: { strings?: unknown; vpcs?: unknown; vpces?: unknown }, conditional: "StringEquals" | "StringNotEquals", resources: JsonObject[]): void {
  const condition: Record<string, unknown[]> = {};
  if (Array.isArray(endpoints.strings)) {
    const vpcs = endpoints.strings.filter(endpoint => typeof endpoint === "string" && endpoint.startsWith("vpc-"));
    const vpces = endpoints.strings.filter(endpoint => typeof endpoint === "string" && endpoint.startsWith("vpce-"));
    if (vpcs.length) (condition["aws:SourceVpc"] ??= []).push(...vpcs);
    if (vpces.length) (condition["aws:SourceVpce"] ??= []).push(...vpces);
  }
  if (Array.isArray(endpoints.vpcs)) (condition["aws:SourceVpc"] ??= []).push(...endpoints.vpcs);
  if (Array.isArray(endpoints.vpces)) (condition["aws:SourceVpce"] ??= []).push(...endpoints.vpces);
  if (!condition["aws:SourceVpc"]?.length && !condition["aws:SourceVpce"]?.length) return;
  resourcePolicy.Version = "2012-10-17";
  const allow = { Effect: "Allow", Action: "execute-api:Invoke", Resource: resources, Principal: "*" };
  const deny = { ...allow, Effect: "Deny", Condition: { [conditional]: condition } };
  appendStatements(resourcePolicy, [allow, deny], true);
}

const resolvedList = (value: unknown) => value === undefined || value === null || (Array.isArray(value) && value.every(item => typeof item === "string"));

/** SwaggerEditor.add_resource_policy for one path. */
export function addResourcePolicy(body: JsonObject, resourcePolicyConfig: unknown, path: string, stage: unknown): void {
  if (resourcePolicyConfig === undefined || resourcePolicyConfig === null) return;
  validateIsDict(resourcePolicyConfig, "Resource Policy is not a valid dictionary.");
  const config = resourcePolicyConfig;
  const resourcePolicy = policy(body);
  const uris = () => methodPathUris(body, path, stage);
  if (config.AwsAccountWhitelist !== undefined && config.AwsAccountWhitelist !== null) iamStatement(resourcePolicy, config.AwsAccountWhitelist, "Allow", uris());
  if (config.AwsAccountBlacklist !== undefined && config.AwsAccountBlacklist !== null) iamStatement(resourcePolicy, config.AwsAccountBlacklist, "Deny", uris());
  if (config.IpRangeWhitelist !== undefined && config.IpRangeWhitelist !== null) ipStatements(resourcePolicy, config.IpRangeWhitelist, "NotIpAddress", uris());
  if (config.IpRangeBlacklist !== undefined && config.IpRangeBlacklist !== null) ipStatements(resourcePolicy, config.IpRangeBlacklist, "IpAddress", uris());
  if (!resolvedList(config.SourceVpcBlacklist)) throw documentError("SourceVpcBlacklist must be a list of strings. Use IntrinsicVpcBlacklist instead for values that use Intrinsic Functions");
  const resources = uris();
  vpcStatements(resourcePolicy, { strings: config.SourceVpcBlacklist, vpcs: config.IntrinsicVpcBlacklist, vpces: config.IntrinsicVpceBlacklist }, "StringEquals", resources);
  if (!resolvedList(config.SourceVpcWhitelist)) throw documentError("SourceVpcWhitelist must be a list of strings. Use IntrinsicVpcWhitelist instead for values that use Intrinsic Functions");
  vpcStatements(resourcePolicy, { strings: config.SourceVpcWhitelist, vpcs: config.IntrinsicVpcWhitelist, vpces: config.IntrinsicVpceWhitelist }, "StringNotEquals", resources);
  body[X_POLICY] = resourcePolicy;
}

/** add_custom_statements. */
export function addCustomStatements(body: JsonObject, statements: unknown): void {
  const resourcePolicy = policy(body);
  if (statements !== undefined && statements !== null) {
    resourcePolicy.Version = "2012-10-17";
    if (resourcePolicy.Statement === undefined || resourcePolicy.Statement === null) resourcePolicy.Statement = statements;
    else {
      const existing = Array.isArray(resourcePolicy.Statement) ? resourcePolicy.Statement : [resourcePolicy.Statement];
      for (const statement of Array.isArray(statements) ? statements : [statements]) if (!existing.some(item => sameJson(item, statement))) existing.push(statement);
      resourcePolicy.Statement = existing;
    }
  }
  body[X_POLICY] = resourcePolicy;
}

// --- Models, request models, validators, and parameters -------------------------------

/** add_models: definitions keyed by lower-cased model name. */
export function addModels(body: JsonObject, models: JsonObject): void {
  const definitions = isObject(body.definitions) && Object.keys(body.definitions).length ? body.definitions : {};
  for (const [name, schema] of Object.entries(models)) {
    if (!(schema as JsonObject).type) throw documentError("'Models' schema is missing 'type'.");
    definitions[name.toLowerCase()] = schema;
  }
  if (Object.keys(definitions).length) body.definitions = definitions;
}

/** add_request_model_to_method. */
export function addRequestModel(body: JsonObject, path: string, method: string, requestModel: JsonObject): void {
  const model = String(requestModel.Model).toLowerCase();
  const required = requestModel.Required;
  for (const definition of methodDefinitions(body, path, method)) {
    if (body.swagger !== undefined && body.swagger !== null) {
      const parameters = (definition.parameters ?? []) as unknown[];
      const parameter: JsonObject = { in: "body", name: model, schema: { $ref: `#/definitions/${model}` } };
      if (required !== undefined && required !== null) parameter.required = required;
      parameters.push(parameter);
      definition.parameters = parameters;
    } else if (body.openapi && /^3(\.\d)(\.\d)?$/.test(String(body.openapi))) {
      definition.requestBody = { content: { "application/json": { schema: { $ref: `#/components/schemas/${model}` } } } };
      if (required !== undefined && required !== null) (definition.requestBody as JsonObject).required = required;
    }
  }
}

function validatorName(body: boolean, parameters: boolean): string {
  return body && parameters ? "body-and-params" : body ? "body-only" : parameters ? "params-only" : "no-validation";
}

/** add_request_validator_to_method. */
export function addRequestValidator(body: JsonObject, path: string, method: string, validateBody: boolean, validateParameters: boolean): void {
  const name = validatorName(validateBody, validateParameters);
  if (!body["x-amazon-apigateway-request-validators"]) body["x-amazon-apigateway-request-validators"] = {};
  const validators = body["x-amazon-apigateway-request-validators"] as JsonObject;
  if (!validators[name]) validators[name] = { validateRequestBody: validateBody, validateRequestParameters: validateParameters };
  for (const definition of methodDefinitions(body, path, method)) definition["x-amazon-apigateway-request-validator"] = name;
}

/** add_request_parameters_to_method. */
export function addRequestParameters(body: JsonObject, path: string, method: string, parameters: Array<{ Name: string; Required: unknown; Caching: unknown }>): void {
  for (const definition of methodDefinitions(body, path, method)) {
    const existing = (definition.parameters ?? []) as unknown[];
    for (const parameter of parameters) {
      const [rawLocation, ...rest] = parameter.Name.replace("method.request.", "").split(".");
      existing.push({ in: rawLocation === "querystring" ? "query" : rawLocation, name: rest.join("."), required: parameter.Required, type: "string" });
      if (parameter.Caching) {
        const integration = definition[X_INTEGRATION] as JsonObject;
        integration.cacheKeyParameters = [...((integration.cacheKeyParameters ?? []) as unknown[]), parameter.Name];
      }
    }
    definition.parameters = existing;
  }
}

export const isIntrinsicValue = (value: unknown): boolean => isIntrinsic(value);
