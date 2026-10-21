import { cfnResource, eventError, fnSub, isNoValue, isObject, pythonStr, ref, resourceError, type JsonObject } from "./common.js";
import { conditionalContents, documentError, expect, methodDefinitions, validateIsDict } from "./rest-auth.js";
import { normalizeMethod, X_INTEGRATION } from "./swagger.js";

/**
 * HTTP API Auth: SAM's ApiGatewayV2Authorizer (JWT and Lambda REQUEST
 * authorizers), OpenApiEditor's default-authorizer and per-route security,
 * and the authorizer permissions HttpApiGenerator adds.
 */

const AUTH_KEYS = ["Authorizers", "DefaultAuthorizer", "EnableIamAuthorizer"];

type AuthorizerType = "AWS_IAM" | "JWT" | "REQUEST";

export interface HttpAuthorizer {
  readonly name: string;
  readonly isAwsIam: boolean;
  readonly authorizationScopes?: unknown;
  readonly jwtConfiguration?: JsonObject;
  readonly identitySource?: unknown;
  readonly functionArn?: unknown;
  readonly functionInvokeRole?: unknown;
  readonly identity?: unknown;
  readonly payloadFormatVersion?: unknown;
  readonly enableSimpleResponses?: unknown;
  readonly enableFunctionDefaultPermissions?: unknown;
}

/** Display names and the authorizer kind each property belongs to (PROPERTY_DISPLAY). */
const PROPERTIES: ReadonlyArray<[keyof HttpAuthorizer, string, string, AuthorizerType]> = [
  ["authorizationScopes", "AuthorizationScopes", "OAuth2 Authorizer", "JWT"],
  ["jwtConfiguration", "JwtConfiguration", "OAuth2 Authorizer", "JWT"],
  ["identitySource", "IdentitySource", "OAuth2 Authorizer. For Lambda Authorizer, use the 'Identity' property instead", "JWT"],
  ["functionArn", "FunctionArn", "Lambda Authorizer", "REQUEST"],
  ["functionInvokeRole", "FunctionInvokeRole", "Lambda Authorizer", "REQUEST"],
  ["identity", "Identity", "Lambda Authorizer", "REQUEST"],
  ["payloadFormatVersion", "AuthorizerPayloadFormatVersion", "Lambda Authorizer", "REQUEST"],
  ["enableSimpleResponses", "EnableSimpleResponses", "Lambda Authorizer", "REQUEST"],
  ["enableFunctionDefaultPermissions", "EnableFunctionDefaultPermissions", "Lambda Authorizer", "REQUEST"],
];

const defined = (value: unknown) => value !== undefined && value !== null;
const authorizerType = (authorizer: HttpAuthorizer): AuthorizerType => authorizer.isAwsIam ? "AWS_IAM" : authorizer.jwtConfiguration ? "JWT" : "REQUEST";

/** ApiGatewayV2Authorizer.__init__ with its validations. */
function httpAuthorizer(apiId: string, name: string, config: JsonObject): HttpAuthorizer {
  let jwtConfiguration: JsonObject | undefined;
  if (config.JwtConfiguration) {
    expect(config.JwtConfiguration, apiId, "JwtConfiguration", "map");
    // OpenAPI wants lower-case keys; SAM accepts either case.
    jwtConfiguration = Object.fromEntries(Object.entries(config.JwtConfiguration as JsonObject).map(([key, value]) => [key.toLowerCase(), value]));
  }
  const authorizer: HttpAuthorizer = {
    name,
    isAwsIam: false,
    authorizationScopes: config.AuthorizationScopes,
    jwtConfiguration,
    identitySource: config.IdentitySource,
    functionArn: config.FunctionArn,
    functionInvokeRole: config.FunctionInvokeRole,
    identity: config.Identity,
    payloadFormatVersion: config.AuthorizerPayloadFormatVersion,
    enableSimpleResponses: config.EnableSimpleResponses,
    enableFunctionDefaultPermissions: config.EnableFunctionDefaultPermissions,
  };
  const type = authorizerType(authorizer);
  if (defined(authorizer.authorizationScopes) && !Array.isArray(authorizer.authorizationScopes)) throw resourceError(apiId, "AuthorizationScopes must be a list.");
  for (const [key, display, owner, ownerType] of PROPERTIES) {
    if (defined(authorizer[key]) && ownerType !== type) throw resourceError(apiId, `${display} is only supported for ${owner}.`);
  }
  if (type === "JWT" && !authorizer.identitySource) throw resourceError(apiId, `${name} OAuth2 Authorizer must define 'IdentitySource'.`);
  if (type === "REQUEST") {
    if (!authorizer.functionArn) throw resourceError(apiId, `${name} Lambda Authorizer must define 'FunctionArn'.`);
    if (!authorizer.payloadFormatVersion) throw resourceError(apiId, `${name} Lambda Authorizer must define 'AuthorizerPayloadFormatVersion'.`);
  }
  if (defined(authorizer.enableFunctionDefaultPermissions)) expect(authorizer.enableFunctionDefaultPermissions, apiId, `Authorizers.${name}.EnableFunctionDefaultPermissions`, "boolean");
  return authorizer;
}

/** HttpApiGenerator._get_authorizers. */
export function httpAuthorizers(apiId: string, config: unknown, enableIamAuthorizer: unknown): Record<string, HttpAuthorizer> {
  const authorizers: Record<string, HttpAuthorizer> = {};
  if (enableIamAuthorizer === true) authorizers.AWS_IAM = { name: "AWS_IAM", isAwsIam: true };
  if (!config || (isObject(config) && !Object.keys(config).length)) return authorizers;
  expect(config, apiId, "Auth.Authorizers", "map");
  for (const [name, authorizer] of Object.entries(config as JsonObject)) {
    expect(authorizer, apiId, `Auth.Authorizers.${name}`, "map");
    if (Object.hasOwn(authorizer as JsonObject, "OpenIdConnectUrl")) throw resourceError(apiId, `'OpenIdConnectUrl' is no longer a supported property for authorizer '${name}'. Please refer to the AWS SAM documentation.`);
    authorizers[name] = httpAuthorizer(apiId, name, authorizer as JsonObject);
  }
  return authorizers;
}

/** ApiGatewayV2Authorizer.generate_openapi: the securitySchemes entry. */
function authorizerOpenApi(apiId: string, authorizer: HttpAuthorizer, partition: string): JsonObject {
  const type = authorizerType(authorizer);
  if (type === "AWS_IAM") return { type: "apiKey", name: "Authorization", in: "header", "x-amazon-apigateway-authtype": "awsSigv4" };
  if (type === "JWT") return { type: "oauth2", "x-amazon-apigateway-authorizer": { jwtConfiguration: authorizer.jwtConfiguration, identitySource: authorizer.identitySource, type: "jwt" } };
  const extension: JsonObject = {
    type: "request",
    authorizerUri: fnSub(`arn:${partition}:apigateway:\${AWS::Region}:lambda:path/2015-03-31/functions/\${__FunctionArn__}/invocations`, { __FunctionArn__: authorizer.functionArn }),
  };
  if (authorizer.functionInvokeRole && authorizer.functionInvokeRole !== "NONE") extension.authorizerCredentials = authorizer.functionInvokeRole;
  if (authorizer.identity) {
    expect(authorizer.identity, apiId, `Auth.Authorizers.${authorizer.name}.Identity`, "map");
    const identity = authorizer.identity as JsonObject;
    if (defined(identity.ReauthorizeEvery)) extension.authorizerResultTtlInSeconds = identity.ReauthorizeEvery;
    const source: string[] = [];
    for (const [prefix, key] of [["$request.header.", "Headers"], ["$request.querystring.", "QueryStrings"], ["$stageVariables.", "StageVariables"], ["$context.", "Context"]] as const) {
      const values = identity[key];
      if (!values) continue;
      const path = `Authorizers.${authorizer.name}.Identity.${key}`;
      expect(values, apiId, path, "list");
      (values as unknown[]).forEach((value, index) => expect(value, apiId, `${path}[${index}]`, "string"));
      source.push(...(values as string[]).map(value => `${prefix}${value}`));
    }
    extension.identitySource = source;
  }
  extension.authorizerPayloadFormatVersion = authorizer.payloadFormatVersion;
  if (authorizer.enableSimpleResponses) extension.enableSimpleResponses = authorizer.enableSimpleResponses;
  return { type: "apiKey", name: "Unused", in: "header", "x-amazon-apigateway-authorizer": extension };
}

/** OpenApiEditor.set_path_default_authorizer: routes without security get the default authorizer. */
function setPathDefaultAuthorizer(body: JsonObject, path: string, defaultAuthorizer: string, authorizers: Record<string, HttpAuthorizer>): void {
  for (const item of conditionalContents((body.paths as JsonObject)[path])) {
    validateIsDict(item, `Value of '${path}' path must be a dictionary according to Swagger spec.`);
    for (const [methodName, method] of Object.entries(item)) {
      const normalized = normalizeMethod(methodName) as string;
      if (normalized === "parameters" || normalized === "options") continue;
      if (!Object.hasOwn(item, normalized)) throw documentError(`Could not find ${normalized} in ${path} within DefinitionBody.`);
      for (const raw of conditionalContents(method)) {
        validateIsDict(raw, `Definition of method '${methodName}' for path '${path}' should be a map.`);
        if (!raw[X_INTEGRATION] || raw.security) continue;
        const scopes = authorizers[defaultAuthorizer]?.authorizationScopes;
        raw.security = [{ [defaultAuthorizer]: defined(scopes) ? scopes : [] }];
      }
    }
  }
}

/**
 * HttpApiGenerator._add_auth: the authorizers' securitySchemes and the
 * default authorizer on every route without its own security.
 */
export function addHttpAuth(apiId: string, auth: unknown, body: JsonObject | undefined, partition: string, isOpenApiDocument: (value: unknown) => boolean): void {
  if (!auth || (isObject(auth) && !Object.keys(auth).length)) return;
  if (!body) throw resourceError(apiId, "Auth works only with inline OpenApi specified in the 'DefinitionBody' property.");
  if (!isObject(auth) || !Object.keys(auth).every(key => AUTH_KEYS.includes(key))) throw resourceError(apiId, "Invalid value for 'Auth' property");
  if (!isOpenApiDocument(body)) throw resourceError(apiId, "Unable to add Auth configuration because 'DefinitionBody' does not contain a valid OpenApi definition.");
  const authorizers = httpAuthorizers(apiId, auth.Authorizers, auth.EnableIamAuthorizer ?? false);
  const components = isObject(body.components) ? body.components : undefined;
  const schemes = components && isObject(components.securitySchemes) && Object.keys(components.securitySchemes).length ? components.securitySchemes : {};
  for (const [name, authorizer] of Object.entries(authorizers)) schemes[name] = authorizerOpenApi(apiId, authorizer, partition);
  if (Object.keys(schemes).length) body.components = { ...(components ?? {}), securitySchemes: schemes };
  const defaultAuthorizer = auth.DefaultAuthorizer;
  if (!defaultAuthorizer || isNoValue(defaultAuthorizer)) return;
  expect(defaultAuthorizer, apiId, "Auth.DefaultAuthorizer", "string");
  if (!authorizers[defaultAuthorizer as string]) throw resourceError(apiId, `Unable to set DefaultAuthorizer because '${defaultAuthorizer as string}' was not defined in 'Authorizers'.`);
  for (const path of Object.keys(body.paths as JsonObject)) setPathDefaultAuthorizer(body, path, defaultAuthorizer as string, authorizers);
}

/** `<Api><Authorizer>AuthorizerPermission` for Lambda authorizers with EnableFunctionDefaultPermissions. */
export function httpAuthorizerPermissions(apiId: string, auth: unknown, attributes: JsonObject): Record<string, JsonObject> {
  if (!auth || !isObject(auth) || !Object.keys(auth).length) return {};
  const output: Record<string, JsonObject> = {};
  for (const [name, authorizer] of Object.entries(httpAuthorizers(apiId, auth.Authorizers, auth.EnableIamAuthorizer ?? false))) {
    if (!authorizer.functionArn || !authorizer.enableFunctionDefaultPermissions) continue;
    output[`${apiId}${name}AuthorizerPermission`] = cfnResource("AWS::Lambda::Permission", {
      Action: "lambda:InvokeFunction",
      FunctionName: authorizer.functionArn,
      Principal: "apigateway.amazonaws.com",
      SourceArn: fnSub("arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${__ApiId__}/authorizers/*", { __ApiId__: ref(apiId) }),
    }, attributes);
  }
  return output;
}

/** HttpApi._add_auth_to_openapi_integration: a route's Authorizer and AuthorizationScopes. */
export function addHttpRouteAuth(eventId: string, api: JsonObject, apiId: string, body: JsonObject, auth: JsonObject, method: string, path: string): void {
  const apiAuth = Object.hasOwn(api, "Auth") ? api.Auth : {};
  expect(apiAuth, apiId, "Auth", "map");
  const settings = apiAuth as JsonObject;
  let methodAuthorizer = auth.Authorizer;
  if (!methodAuthorizer) {
    if (!settings.DefaultAuthorizer) throw eventError(eventId, "'Auth' section requires either an explicit 'Authorizer' set or a 'DefaultAuthorizer' configured on the HttpApi.");
    auth.Authorizer = methodAuthorizer = settings.DefaultAuthorizer;
  }
  // Python's `api_auth and api_auth.get("Authorizers")`: an empty Auth map is itself the (empty) authorizers.
  const authorizers = Object.keys(settings).length ? settings.Authorizers : settings;
  const iamEnabled = settings.EnableIamAuthorizer === true;
  const quoted = pythonStr(methodAuthorizer);
  if (methodAuthorizer !== "NONE" && !(methodAuthorizer === "AWS_IAM" && iamEnabled) && (typeof methodAuthorizer !== "string" || !isObject(authorizers))) {
    throw eventError(eventId, `Unable to set Authorizer [${quoted}] on API method [${method}] for path [${path}]. The method authorizer must be a string with a corresponding dict entry in the api authorizer.`);
  }
  if (methodAuthorizer === "NONE") {
    if (!settings.DefaultAuthorizer) throw eventError(eventId, `Unable to set Authorizer on API method [${method}] for path [${path}] because 'NONE' is only a valid value when a DefaultAuthorizer on the API is specified.`);
  } else if ((methodAuthorizer === "AWS_IAM" && !iamEnabled) || methodAuthorizer !== "AWS_IAM") {
    if (!authorizers || (isObject(authorizers) && !Object.keys(authorizers).length)) throw eventError(eventId, `Unable to set Authorizer [${quoted}] on API method [${method}] for path [${path}] because the related API does not define any Authorizers.`);
    if (!(authorizers as JsonObject)[methodAuthorizer as string]) throw eventError(eventId, `Unable to set Authorizer [${quoted}] on API method [${method}] for path [${path}] because it wasn't defined in the API's Authorizers.`);
  }
  if (auth.AuthorizationScopes && !Array.isArray(auth.AuthorizationScopes)) throw eventError(eventId, `Unable to set Authorizer on API method [${method}] for path [${path}] because 'AuthorizationScopes' must be a list of strings.`);
  const routeScopes = auth.AuthorizationScopes ?? [];
  for (const definition of methodDefinitions(body, path, method)) {
    const entry: JsonObject = { [methodAuthorizer as string]: [] };
    if (methodAuthorizer !== "NONE" && methodAuthorizer !== "AWS_IAM") {
      const authorizer = isObject(authorizers) ? authorizers[methodAuthorizer as string] ?? {} : {};
      if (!isObject(authorizer)) throw documentError(`Type of authorizer '${methodAuthorizer as string}' must be a dictionary`);
      let scopes = authorizer.AuthorizationScopes;
      if (Array.isArray(routeScopes) ? routeScopes.length : routeScopes) scopes = routeScopes;
      if ((authorizers as JsonObject)[methodAuthorizer as string] && (Array.isArray(scopes) ? scopes.length : scopes)) entry[methodAuthorizer as string] = scopes;
    }
    const existing = Object.hasOwn(definition, "security") ? definition.security : [];
    if (!Array.isArray(existing)) throw documentError(`Type of security for path ${path} method ${method} must be a list`);
    definition.security = [...existing, entry];
  }
}
