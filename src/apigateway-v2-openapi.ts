/*
 * OpenAPI 3.0 import/export for API Gateway v2 HTTP APIs (ImportApi, ReimportApi, ExportApi).
 * The YAML/JSON reader and YAML writer are shared with the REST importer; the HTTP API
 * extension vocabulary (x-amazon-apigateway-integration for aws_proxy/http_proxy,
 * x-amazon-apigateway-cors, x-amazon-apigateway-authorizer jwt/request, awsSigv4 auth
 * type, x-amazon-apigateway-importexport-version) is handled here.
 */
import { parseOpenApiDocument, stringifyOpenApiYaml } from "./apigateway-openapi.js";
import type { HttpApiAuthorizerState, HttpApiDeploymentSnapshotState, HttpApiIntegrationState, HttpApiRouteState, HttpApiState } from "./types.js";

type JsonObject = Record<string, any>;

const OPENAPI_METHODS: Record<string, string> = { get: "GET", put: "PUT", post: "POST", delete: "DELETE", patch: "PATCH", head: "HEAD", options: "OPTIONS", "x-amazon-apigateway-any-method": "ANY" };
const ANY_METHOD = "x-amazon-apigateway-any-method";
const IAM_SCHEME = "sigv4";

export class HttpApiOpenApiError extends Error {}

export interface HttpApiImportedRoute { routeKey: string; operationName?: string; integrationKey?: string; authorizationType: "NONE" | "AWS_IAM" | "CUSTOM" | "JWT"; authorizerName?: string; authorizationScopes: string[] }

export interface HttpApiOpenApiImport {
  name: string; description?: string; version?: string; corsConfiguration?: JsonObject;
  /** camelCase CreateAuthorizer inputs keyed by security scheme name. */
  authorizers: Record<string, JsonObject>;
  /** camelCase CreateIntegration inputs keyed by a stable integration key (route key or shared $ref). */
  integrations: Record<string, JsonObject>;
  routes: HttpApiImportedRoute[];
  warnings: string[]; importInfo: string[];
}

function isObject(value: unknown): value is JsonObject { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function versionString(value: unknown): string | undefined { if (value === undefined || value === null || value === "") return undefined; return typeof value === "number" ? value.toFixed(1) : String(value); }
function identityList(value: unknown): string[] | undefined { if (value === undefined || value === null) return undefined; if (Array.isArray(value)) return value.map(String).map(item => item.trim()).filter(Boolean); return String(value).split(",").map(item => item.trim()).filter(Boolean); }

function basePathOf(document: JsonObject): string {
  const servers = Array.isArray(document.servers) ? document.servers.filter(isObject) : [];
  for (const server of servers) if (isObject(server.variables) && isObject(server.variables.basePath)) return String(server.variables.basePath.default ?? "").replace(/^\/+|\/+$/g, "");
  const first = servers[0]; if (!first || typeof first.url !== "string") return "";
  const variables = isObject(first.variables) ? first.variables : {};
  const url = first.url.replace(/\{([^}]+)\}/g, (_match: string, name: string) => String(isObject(variables[name]) ? variables[name].default ?? "" : ""));
  try { return new URL(url, "https://placeholder.invalid").pathname.replace(/^\/+|\/+$/g, ""); } catch { return ""; }
}

function resolveRef(document: JsonObject, ref: string): unknown {
  if (!ref.startsWith("#/")) throw new HttpApiOpenApiError(`Only local $ref values are supported: ${ref}`);
  let current: unknown = document; for (const part of ref.slice(2).split("/").map(value => value.replace(/~1/g, "/").replace(/~0/g, "~"))) { if (!isObject(current)) return undefined; current = current[part]; }
  return current;
}

function integrationInput(raw: JsonObject, routeKey: string, warnings: string[]): JsonObject | undefined {
  const type = String(raw.type ?? "").toLowerCase();
  const integrationType = type === "aws_proxy" ? "AWS_PROXY" : type === "http_proxy" ? "HTTP_PROXY" : undefined;
  if (!integrationType) { warnings.push(`Integration type ${raw.type === undefined ? "(missing)" : String(raw.type)} for route ${routeKey} is not supported for HTTP APIs. HTTP APIs support only Lambda proxy (aws_proxy) and HTTP proxy (http_proxy) integrations.`); return undefined; }
  const input: JsonObject = { integrationType };
  if (raw.uri !== undefined) input.integrationUri = String(raw.uri);
  if (raw.httpMethod !== undefined) input.integrationMethod = String(raw.httpMethod).toUpperCase();
  const payload = versionString(raw.payloadFormatVersion); if (payload) input.payloadFormatVersion = payload;
  if (raw.connectionType !== undefined) input.connectionType = String(raw.connectionType).toUpperCase();
  if (raw.connectionId !== undefined) input.connectionId = String(raw.connectionId);
  if (raw.timeoutInMillis !== undefined) input.timeoutInMillis = Number(raw.timeoutInMillis);
  if (raw.integrationSubtype !== undefined) input.integrationSubtype = String(raw.integrationSubtype);
  if (raw.credentials !== undefined) input.credentialsArn = String(raw.credentials);
  if (raw.description !== undefined) input.description = String(raw.description);
  if (isObject(raw.requestParameters)) input.requestParameters = Object.fromEntries(Object.entries(raw.requestParameters).map(([key, value]) => [key, String(value)]));
  if (isObject(raw.responseParameters)) input.responseParameters = Object.fromEntries(Object.entries(raw.responseParameters).map(([status, value]) => [status, Object.fromEntries(Object.entries(isObject(value) ? value : {}).map(([key, item]) => [key, String(item)]))]));
  if (isObject(raw.tlsConfig)) input.tlsConfig = structuredClone(raw.tlsConfig);
  return input;
}

function authorizerInput(name: string, scheme: JsonObject, importInfo: string[]): JsonObject | "iam" | undefined {
  if (String(scheme["x-amazon-apigateway-authtype"] ?? "").toLowerCase() === "awssigv4") return "iam";
  const raw = scheme["x-amazon-apigateway-authorizer"];
  if (!isObject(raw)) { importInfo.push(`Security scheme ${name} has no x-amazon-apigateway-authorizer and was ignored.`); return undefined; }
  const type = String(raw.type ?? "").toLowerCase();
  if (type === "jwt") {
    const jwt = isObject(raw.jwtConfiguration) ? raw.jwtConfiguration : {};
    return { name, authorizerType: "JWT", identitySource: identityList(raw.identitySource) ?? ["$request.header.Authorization"], jwtConfiguration: { issuer: jwt.issuer, audience: Array.isArray(jwt.audience) ? jwt.audience.map(String) : jwt.audience === undefined ? undefined : [String(jwt.audience)] } };
  }
  if (type === "request") {
    const input: JsonObject = { name, authorizerType: "REQUEST", authorizerUri: raw.authorizerUri, authorizerPayloadFormatVersion: versionString(raw.authorizerPayloadFormatVersion) ?? "2.0" };
    const identitySource = identityList(raw.identitySource); if (identitySource) input.identitySource = identitySource;
    if (raw.authorizerResultTtlInSeconds !== undefined) input.authorizerResultTtlInSeconds = Number(raw.authorizerResultTtlInSeconds);
    if (raw.enableSimpleResponses !== undefined) input.enableSimpleResponses = Boolean(raw.enableSimpleResponses);
    if (raw.authorizerCredentials !== undefined) input.authorizerCredentialsArn = String(raw.authorizerCredentials);
    return input;
  }
  throw new HttpApiOpenApiError(`Security scheme ${name} uses unsupported authorizer type ${String(raw.type)}; HTTP APIs support jwt and request authorizers`);
}

/** Translate an OpenAPI 3.0 document into HTTP API resource inputs. Errors stop the import; warnings and info follow AWS's three validation categories. */
export function parseHttpApiOpenApi(body: string | Buffer, basepath = "ignore"): HttpApiOpenApiImport {
  let document: JsonObject;
  try { document = parseOpenApiDocument(Buffer.isBuffer(body) ? body : Buffer.from(String(body))); } catch (error) { throw new HttpApiOpenApiError(error instanceof Error ? error.message : String(error)); }
  if (document.swagger !== undefined || typeof document.openapi !== "string" || !/^3\.0(?:\.\d+)?$/.test(document.openapi)) throw new HttpApiOpenApiError("HTTP APIs support only OpenAPI 3.0 definitions. Specify openapi: 3.0.x.");
  const info = isObject(document.info) ? document.info : {};
  const name = typeof info.title === "string" ? info.title.trim() : "";
  if (!name) throw new HttpApiOpenApiError("The OpenAPI definition must specify info.title, which becomes the API name");
  if (!new Set(["ignore", "prepend", "split"]).has(basepath)) throw new HttpApiOpenApiError("basepath must be ignore, prepend, or split");
  const warnings: string[] = []; const importInfo: string[] = [];
  const version = document["x-amazon-apigateway-importexport-version"]; if (version !== undefined && versionString(version) !== "1.0") warnings.push(`Unsupported x-amazon-apigateway-importexport-version ${String(version)}; StackSim implements version 1.0.`);
  for (const key of Object.keys(document)) if (key.startsWith("x-amazon-apigateway-") && !new Set(["x-amazon-apigateway-cors", "x-amazon-apigateway-importexport-version"]).has(key)) importInfo.push(`${key} is not supported for HTTP APIs and was ignored.`);
  const base = basePathOf(document).split("/").filter(Boolean); const prefixSegments = basepath === "prepend" ? base : basepath === "split" ? base.slice(1) : []; const prefix = prefixSegments.length ? `/${prefixSegments.join("/")}` : "";
  const components = isObject(document.components) ? document.components : {}; const schemes = isObject(components.securitySchemes) ? components.securitySchemes : {};
  const authorizers: Record<string, JsonObject> = {}; const iamSchemes = new Set<string>();
  for (const [schemeName, scheme] of Object.entries(schemes)) { if (!isObject(scheme)) continue; const input = authorizerInput(schemeName, scheme, importInfo); if (input === "iam") iamSchemes.add(schemeName); else if (input) authorizers[schemeName] = input; }
  const integrations: Record<string, JsonObject> = {}; const routes: HttpApiImportedRoute[] = []; const seen = new Set<string>();
  const paths = isObject(document.paths) ? document.paths : {};
  for (const [rawPath, item] of Object.entries(paths)) {
    if (!isObject(item)) { warnings.push(`Path ${rawPath} is not an object and was ignored.`); continue; }
    const defaultRoute = rawPath === "/$default" || rawPath === "$default";
    if (!defaultRoute && !rawPath.startsWith("/")) throw new HttpApiOpenApiError(`Path ${rawPath} must start with /`);
    for (const [methodName, operation] of Object.entries(item)) {
      const method = OPENAPI_METHODS[methodName.toLowerCase()];
      if (!method) { if (methodName.toLowerCase() === "trace") warnings.push(`TRACE ${rawPath} is not supported for HTTP APIs and was ignored.`); continue; }
      if (!isObject(operation)) continue;
      const routeKey = defaultRoute ? "$default" : `${method} ${prefix}${rawPath === "/" && prefix ? "" : rawPath}`;
      if (seen.has(routeKey)) throw new HttpApiOpenApiError(`Duplicate route ${routeKey}`); seen.add(routeKey);
      if (operation.requestBody !== undefined) importInfo.push(`Request validation is not supported for HTTP APIs; requestBody for ${routeKey} was ignored.`);
      let rawIntegration = operation["x-amazon-apigateway-integration"]; let integrationKey: string | undefined;
      if (isObject(rawIntegration) && typeof rawIntegration.$ref === "string") { integrationKey = `ref:${rawIntegration.$ref}`; rawIntegration = resolveRef(document, rawIntegration.$ref); if (!isObject(rawIntegration)) throw new HttpApiOpenApiError(`Integration reference ${integrationKey.slice(4)} for route ${routeKey} does not resolve`); }
      if (isObject(rawIntegration)) {
        integrationKey ??= `route:${routeKey}`;
        if (!integrations[integrationKey]) { const input = integrationInput(rawIntegration, routeKey, warnings); if (input) integrations[integrationKey] = input; else integrationKey = undefined; }
      }
      const security = operation.security ?? document.security; let authorizationType: HttpApiImportedRoute["authorizationType"] = "NONE"; let authorizerName: string | undefined; let scopes: string[] = [];
      if (Array.isArray(security) && security.length) {
        const requirements = security.filter(value => isObject(value) && Object.keys(value).length);
        if (requirements.length > 1 || requirements.some(value => Object.keys(value).length > 1)) throw new HttpApiOpenApiError(`Route ${routeKey} declares multiple security requirements; each HTTP API operation can use only one of IAM authorization, a Lambda authorizer, or a JWT authorizer`);
        if (requirements.length === 1) {
          const [schemeName, requested] = Object.entries(requirements[0])[0];
          if (iamSchemes.has(schemeName)) authorizationType = "AWS_IAM";
          else if (authorizers[schemeName]) { authorizerName = schemeName; authorizationType = authorizers[schemeName].authorizerType === "JWT" ? "JWT" : "CUSTOM"; scopes = Array.isArray(requested) ? requested.map(String) : []; }
          else warnings.push(`Route ${routeKey} references security scheme ${schemeName}, which has no usable API Gateway authorizer; the route was imported without authorization.`);
        }
      }
      routes.push({ routeKey, ...(typeof operation.operationId === "string" ? { operationName: operation.operationId } : {}), ...(integrationKey ? { integrationKey } : {}), authorizationType, ...(authorizerName ? { authorizerName } : {}), authorizationScopes: scopes });
    }
  }
  const cors = document["x-amazon-apigateway-cors"];
  return { name, ...(typeof info.description === "string" ? { description: info.description } : {}), ...(info.version !== undefined ? { version: String(info.version) } : {}), ...(isObject(cors) ? { corsConfiguration: structuredClone(cors) } : {}), authorizers, integrations, routes, warnings, importInfo };
}

function exportIntegration(integration: HttpApiIntegrationState): JsonObject {
  return Object.fromEntries(Object.entries({
    payloadFormatVersion: integration.payloadFormatVersion, type: integration.integrationType.toLowerCase(), httpMethod: integration.integrationMethod,
    uri: integration.integrationUri, connectionType: integration.connectionType, timeoutInMillis: integration.timeoutInMillis,
    integrationSubtype: integration.integrationSubtype, credentials: integration.credentialsArn, description: integration.description,
    requestParameters: Object.keys(integration.requestParameters).length ? structuredClone(integration.requestParameters) : undefined,
    responseParameters: Object.keys(integration.responseParameters).length ? structuredClone(integration.responseParameters) : undefined,
  }).filter(([, value]) => value !== undefined));
}

function exportScheme(authorizer: HttpApiAuthorizerState): JsonObject {
  if (authorizer.authorizerType === "JWT") return { type: "oauth2", flows: {}, "x-amazon-apigateway-authorizer": { identitySource: authorizer.identitySource.join(","), jwtConfiguration: { audience: [...(authorizer.jwtConfiguration?.audience ?? [])], issuer: authorizer.jwtConfiguration?.issuer }, type: "jwt" } };
  const header = authorizer.identitySource.map(value => value.match(/^\$request\.header\.(.+)$/i)?.[1]).find(Boolean);
  return { type: "apiKey", name: header ?? "Unused", in: "header", "x-amazon-apigateway-authorizer": Object.fromEntries(Object.entries({ identitySource: authorizer.identitySource.length ? authorizer.identitySource.join(",") : undefined, authorizerUri: authorizer.authorizerUri, authorizerCredentials: authorizer.authorizerCredentialsArn, authorizerPayloadFormatVersion: authorizer.authorizerPayloadFormatVersion, authorizerResultTtlInSeconds: authorizer.authorizerResultTtlInSeconds, type: "request", enableSimpleResponses: authorizer.enableSimpleResponses }).filter(([, value]) => value !== undefined)) };
}

function stripExtensions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripExtensions);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key === ANY_METHOD || !key.startsWith("x-amazon-apigateway-")).map(([key, item]) => [key, stripExtensions(item)]));
}

function exportDate(epoch: number): string { return `${new Date(epoch).toISOString().slice(0, 19).replace("T", " ")}UTC`; }

export interface HttpApiOpenApiExportInput { api: HttpApiState; snapshot: HttpApiDeploymentSnapshotState; stageName?: string; includeExtensions: boolean }

/** Export an HTTP API (latest configuration or a stage's deployed snapshot) as an OpenAPI 3.0 document. */
export function exportHttpApiOpenApi(input: HttpApiOpenApiExportInput): JsonObject {
  const { api, snapshot } = input;
  const document: JsonObject = { openapi: "3.0.1", info: { title: api.name, ...(api.description ? { description: api.description } : {}), version: api.version ?? exportDate(api.createdDate) } };
  document.servers = [{ url: `${api.apiEndpoint}/{basePath}`, variables: { basePath: { default: input.stageName && input.stageName !== "$default" ? input.stageName : "" } } }];
  const paths: JsonObject = {}; const schemes: JsonObject = {};
  const routes = Object.values(snapshot.routes).filter(route => route.routeId !== "cors-preflight").sort((a, b) => a.routeKey.localeCompare(b.routeKey));
  for (const route of routes as HttpApiRouteState[]) {
    const [method, path] = route.routeKey === "$default" ? ["ANY", "/$default"] : route.routeKey.split(/\s+/, 2);
    const item = paths[path] ??= {}; const methodKey = method === "ANY" ? ANY_METHOD : method.toLowerCase();
    const operation: JsonObject = { ...(route.operationName ? { operationId: route.operationName } : {}), ...(route.routeKey === "$default" ? { isDefaultRoute: true } : {}), responses: { default: { description: `Default response for ${route.routeKey}` } } };
    if (route.authorizationType === "AWS_IAM") { operation.security = [{ [IAM_SCHEME]: [] }]; schemes[IAM_SCHEME] = { type: "apiKey", name: "Authorization", in: "header", "x-amazon-apigateway-authtype": "awsSigv4" }; }
    else if ((route.authorizationType === "JWT" || route.authorizationType === "CUSTOM") && route.authorizerId && snapshot.authorizers[route.authorizerId]) { const authorizer = snapshot.authorizers[route.authorizerId]; operation.security = [{ [authorizer.name]: route.authorizationType === "JWT" ? [...route.authorizationScopes] : [] }]; schemes[authorizer.name] = exportScheme(authorizer); }
    const integrationId = route.target?.match(/^integrations\/(.+)$/)?.[1]; const integration = integrationId ? snapshot.integrations[integrationId] : undefined;
    if (integration) operation["x-amazon-apigateway-integration"] = exportIntegration(integration);
    item[methodKey] = operation;
    const names = [...path.matchAll(/\{([^}+]+)\+?\}/g)].map(match => match[1]);
    if (names.length && !item.parameters) item.parameters = names.map(name => ({ name, in: "path", description: `Generated path parameter for ${name}`, required: true, schema: { type: "string" } }));
  }
  document.paths = paths;
  if (Object.keys(schemes).length) document.components = { securitySchemes: schemes };
  if (snapshot.corsConfiguration) document["x-amazon-apigateway-cors"] = structuredClone(snapshot.corsConfiguration);
  document["x-amazon-apigateway-importexport-version"] = "1.0";
  return input.includeExtensions ? document : stripExtensions(document) as JsonObject;
}

export function serializeHttpApiOpenApi(document: JsonObject, outputType: "JSON" | "YAML"): { body: string; contentType: string } {
  return outputType === "YAML" ? { body: stringifyOpenApiYaml(document), contentType: "application/yaml" } : { body: JSON.stringify(document, null, 2), contentType: "application/json" };
}
