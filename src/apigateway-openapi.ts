import { defaultApiModels } from "./apigateway-schema.js";
import type { ApiAuthorizerState, ApiDeploymentSnapshot, ApiGatewayResponseState, ApiIntegrationResponseState, ApiIntegrationState, ApiMethodResponseState, ApiMethodState, ApiModelState, ApiRequestValidatorState, ApiResource, RestApiState } from "./types.js";
import { id } from "./util.js";

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "patch", "head", "options", "trace", "x-amazon-apigateway-any-method"]);

interface YamlLine { indent: number; text: string; raw: string; line: number }

function yamlError(line: YamlLine | undefined, message: string): Error { return new Error(`Invalid OpenAPI YAML${line ? ` at line ${line.line}` : ""}: ${message}`); }
function stripYamlComment(value: string): string {
  let single = false; let double = false; let depth = 0;
  for (let index = 0; index < value.length; index++) { const char = value[index]; const previous = value[index - 1]; if (char === "'" && !double) single = !single; else if (char === '"' && !single && previous !== "\\") double = !double; else if (!single && !double) { if ("[{".includes(char)) depth++; else if ("]}".includes(char)) depth--; else if (char === "#" && depth === 0 && (index === 0 || /\s/.test(value[index - 1]))) return value.slice(0, index).trimEnd(); } }
  return value.trimEnd();
}
function yamlColon(value: string): number {
  let single = false; let double = false; let depth = 0;
  for (let index = 0; index < value.length; index++) { const char = value[index]; const previous = value[index - 1]; if (char === "'" && !double) single = !single; else if (char === '"' && !single && previous !== "\\") double = !double; else if (!single && !double) { if ("[{".includes(char)) depth++; else if ("]}".includes(char)) depth--; else if (char === ":" && depth === 0 && (index + 1 === value.length || /\s/.test(value[index + 1]))) return index; } }
  return -1;
}
function splitFlow(value: string, delimiter: string): string[] {
  const values: string[] = []; let start = 0; let single = false; let double = false; let depth = 0;
  for (let index = 0; index < value.length; index++) { const char = value[index]; const previous = value[index - 1]; if (char === "'" && !double) single = !single; else if (char === '"' && !single && previous !== "\\") double = !double; else if (!single && !double) { if ("[{".includes(char)) depth++; else if ("]}".includes(char)) depth--; else if (char === delimiter && depth === 0) { values.push(value.slice(start, index).trim()); start = index + 1; } } }
  values.push(value.slice(start).trim()); return values.filter(item => item !== "");
}
function yamlScalar(value: string): any {
  const text = value.trim();
  if (text === "" || text === "null" || text === "Null" || text === "NULL" || text === "~") return null;
  if (/^(?:true|false)$/i.test(text)) return text.toLowerCase() === "true";
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text)) return Number(text);
  if (text.startsWith("&") || text.startsWith("*")) throw new Error("YAML anchors and aliases are not supported");
  if (text.startsWith('"')) { try { return JSON.parse(text); } catch { throw new Error("invalid quoted string"); } }
  if (text.startsWith("'")) { if (!text.endsWith("'")) throw new Error("unterminated quoted string"); return text.slice(1, -1).replace(/''/g, "'"); }
  if (text.startsWith("[")) { if (!text.endsWith("]")) throw new Error("unterminated flow sequence"); return splitFlow(text.slice(1, -1), ",").map(yamlScalar); }
  if (text.startsWith("{")) { if (!text.endsWith("}")) throw new Error("unterminated flow mapping"); return Object.fromEntries(splitFlow(text.slice(1, -1), ",").map(entry => { const colon = yamlColon(entry); if (colon < 0) throw new Error("invalid flow mapping"); return [String(yamlScalar(entry.slice(0, colon))), yamlScalar(entry.slice(colon + 1))]; })); }
  return text;
}
function parseYamlBlock(lines: YamlLine[], start: number): { value: any; next: number } {
  const first = lines[start]; if (!first) return { value: {}, next: start }; const indent = first.indent; const sequence = first.text === "-" || first.text.startsWith("- ");
  if (sequence) {
    const result: any[] = []; let index = start;
    while (index < lines.length && lines[index].indent === indent && (lines[index].text === "-" || lines[index].text.startsWith("- "))) {
      const line = lines[index]; const rest = line.text.slice(1).trim(); index++;
      if (!rest) { if (!lines[index] || lines[index].indent <= indent) result.push(null); else { const child = parseYamlBlock(lines, index); result.push(child.value); index = child.next; } continue; }
      const colon = yamlColon(rest);
      if (colon >= 0) {
        const key = String(yamlScalar(rest.slice(0, colon))); const tail = rest.slice(colon + 1).trim(); const item: Record<string, any> = {};
        if (tail === "|" || tail === ">") throw yamlError(line, "block scalars are not supported on an inline sequence mapping key");
        if (tail) item[key] = yamlScalar(tail); else if (lines[index] && lines[index].indent > indent) { const child = parseYamlBlock(lines, index); item[key] = child.value; index = child.next; } else item[key] = null;
        if (lines[index] && lines[index].indent > indent) { const continuation = parseYamlBlock(lines, index); if (!continuation.value || Array.isArray(continuation.value) || typeof continuation.value !== "object") throw yamlError(lines[index], "sequence mapping continuation must be a mapping"); Object.assign(item, continuation.value); index = continuation.next; }
        result.push(item);
      } else { try { result.push(yamlScalar(rest)); } catch (error) { throw yamlError(line, error instanceof Error ? error.message : String(error)); } }
    }
    return { value: result, next: index };
  }
  const result: Record<string, any> = {}; let index = start;
  while (index < lines.length && lines[index].indent === indent && lines[index].text !== "-" && !lines[index].text.startsWith("- ")) {
    const line = lines[index]; const colon = yamlColon(line.text); if (colon < 0) throw yamlError(line, "expected a mapping key followed by ':'");
    let key: string; try { key = String(yamlScalar(line.text.slice(0, colon))); } catch (error) { throw yamlError(line, error instanceof Error ? error.message : String(error)); }
    if (key in result) throw yamlError(line, `duplicate key ${key}`);
    const tail = line.text.slice(colon + 1).trim(); index++;
    if (tail === "|" || tail === ">") { const block: string[] = []; const blockIndent = lines[index]?.indent; while (index < lines.length && blockIndent !== undefined && lines[index].indent >= blockIndent) { block.push(lines[index].raw.slice(blockIndent)); index++; } result[key] = tail === "|" ? `${block.join("\n")}\n` : block.join(" "); }
    else if (tail) { try { result[key] = yamlScalar(tail); } catch (error) { throw yamlError(line, error instanceof Error ? error.message : String(error)); } }
    else if (lines[index] && lines[index].indent > indent) { const child = parseYamlBlock(lines, index); result[key] = child.value; index = child.next; }
    else result[key] = null;
  }
  return { value: result, next: index };
}

export function parseOpenApiDocument(body: Buffer): Record<string, any> {
  if (body.length > 6 * 1024 * 1024) throw new Error("OpenAPI definition exceeds the 6 MB limit");
  const source = body.toString("utf8").replace(/^\uFEFF/, "").trim(); if (!source) throw new Error("OpenAPI definition body is required");
  let document: any;
  if (source.startsWith("{") || source.startsWith("[")) { try { document = JSON.parse(source); } catch { throw new Error("OpenAPI definition must be valid JSON or supported YAML"); } }
  else {
    const lines: YamlLine[] = [];
    for (const [offset, raw] of source.split(/\r?\n/).entries()) { if (/\t/.test(raw.match(/^\s*/)?.[0] ?? "")) throw new Error(`Invalid OpenAPI YAML at line ${offset + 1}: tabs are not supported for indentation`); const indent = raw.length - raw.trimStart().length; const text = stripYamlComment(raw.trimStart()); if (!text || text === "---" || text === "...") continue; lines.push({ indent, text, raw, line: offset + 1 }); }
    if (!lines.length) throw new Error("OpenAPI definition body is required"); const parsed = parseYamlBlock(lines, 0); if (parsed.next !== lines.length) throw yamlError(lines[parsed.next], "invalid indentation"); document = parsed.value;
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("OpenAPI definition must be an object");
  return document;
}

function object(value: unknown): value is Record<string, any> { return !!value && typeof value === "object" && !Array.isArray(value); }
function clone<T>(value: T): T { return structuredClone(value); }
function media(value: string): string { return value.split(";")[0].trim().toLowerCase(); }
function alphanumeric(value: string, suffix = ""): string { const base = value.replace(/[^A-Za-z0-9]/g, ""); return `${base || "Imported"}${suffix}`; }
function modelRef(value: any): string | undefined { const ref = value?.$ref; if (typeof ref !== "string") return undefined; const match = ref.match(/#\/(?:definitions|components\/schemas)\/([^/]+)$/); return match ? decodeURIComponent(match[1].replace(/~1/g, "/").replace(/~0/g, "~")) : ref.match(/\/models\/([^/#?]+)$/)?.[1]; }
function rewriteRefs(value: any, apiId: string): any { if (Array.isArray(value)) return value.map(item => rewriteRefs(item, apiId)); if (!object(value)) return value; return Object.fromEntries(Object.entries(value).map(([key, child]) => key === "$ref" && typeof child === "string" && modelRef({ $ref: child }) ? [key, `https://apigateway.amazonaws.com/restapis/${apiId}/models/${encodeURIComponent(modelRef({ $ref: child })!)}`] : [key, rewriteRefs(child, apiId)])); }
function parameterMap(parameters: unknown[]): Record<string, boolean> { const result: Record<string, boolean> = {}; for (const parameter of parameters) if (object(parameter) && ["path", "query", "header"].includes(parameter.in) && parameter.name) result[`method.request.${parameter.in === "query" ? "querystring" : parameter.in}.${parameter.name}`] = parameter.in === "path" || parameter.required === true; return result; }
function ensureResource(api: RestApiState, path: string): ApiResource {
  const normalized = `/${path.split("/").filter(Boolean).join("/")}`; if (normalized === "/") return api.resources[api.rootResourceId]; let parent = api.resources[api.rootResourceId]; let current = "";
  for (const part of normalized.split("/").filter(Boolean)) { current += `/${part}`; let resource = Object.values(api.resources).find(value => value.path === current); if (!resource) { resource = { id: id(10), parentId: parent.id, pathPart: part, path: current, methods: {}, integrations: {} }; api.resources[resource.id] = resource; } parent = resource; }
  return parent;
}
function schemaModel(api: RestApiState, schema: any, preferred: string, contentType: string): string | undefined {
  const reference = modelRef(schema); if (reference) return reference;
  if (!object(schema)) return undefined; const name = alphanumeric(preferred); api.models![name] = { id: api.models![name]?.id ?? id(10), name, description: `Inline model imported for ${preferred}`, contentType, schema: JSON.stringify(rewriteRefs(schema, api.id)) }; return name;
}
function importedAuthorizers(document: Record<string, any>, api: RestApiState, warnings: string[]): Map<string, ApiAuthorizerState> {
  const definitions = document.swagger ? document.securityDefinitions : document.components?.securitySchemes; const result = new Map<string, ApiAuthorizerState>();
  for (const [name, definition] of Object.entries<any>(definitions ?? {})) {
    const extension = definition?.["x-amazon-apigateway-authorizer"]; if (!extension) continue;
    const type = String(extension.type ?? "token").toUpperCase();
    if (!["TOKEN", "REQUEST", "COGNITO_USER_POOLS"].includes(type) || type !== "COGNITO_USER_POOLS" && !extension.authorizerUri) {
      warnings.push(`Authorizer ${name} uses an unsupported type or has no authorizerUri`);
      continue;
    }
    const existing = Object.values(api.authorizers ?? {}).find(value => value.name === name);
    const authorizer: ApiAuthorizerState = {
      id: existing?.id ?? id(10),
      name,
      type: type as ApiAuthorizerState["type"],
      authorizerUri: extension.authorizerUri,
      authorizerCredentials: extension.authorizerCredentials,
      identitySource: extension.identitySource ?? (definition.name ? `method.request.header.${definition.name}` : type === "COGNITO_USER_POOLS" ? "method.request.header.Authorization" : undefined),
      identityValidationExpression: extension.identityValidationExpression,
      authorizerResultTtlInSeconds: Number(extension.authorizerResultTtlInSeconds ?? 300),
      providerARNs: type === "COGNITO_USER_POOLS" ? clone(extension.providerARNs) : undefined,
    };
    api.authorizers![authorizer.id] = authorizer;
    result.set(name, authorizer);
  }
  return result;
}
function integrationState(extension: any, method: string, warnings: string[]): ApiIntegrationState | undefined {
  if (!object(extension)) return undefined; const type = String(extension.type ?? "").toUpperCase(); if (!["MOCK", "AWS", "AWS_PROXY", "HTTP", "HTTP_PROXY"].includes(type)) { warnings.push(`Integration type ${extension.type ?? "(missing)"} is not supported`); return undefined; }
  const integration: ApiIntegrationState = { type, integrationHttpMethod: String(extension.httpMethod ?? (type === "MOCK" ? "POST" : method)).toUpperCase(), uri: extension.uri, connectionType: String(extension.connectionType ?? "INTERNET").toUpperCase() as "INTERNET" | "VPC_LINK", connectionId: extension.connectionId, credentials: extension.credentials, requestParameters: clone(extension.requestParameters ?? {}), requestTemplates: clone(extension.requestTemplates ?? {}), passthroughBehavior: String(extension.passthroughBehavior ?? "WHEN_NO_MATCH").toUpperCase(), contentHandling: extension.contentHandling, timeoutInMillis: Number(extension.timeoutInMillis ?? 29_000), cacheNamespace: extension.cacheNamespace ?? id(6), cacheKeyParameters: clone(extension.cacheKeyParameters ?? []), tlsConfig: extension.tlsConfig === undefined ? undefined : clone(extension.tlsConfig), responses: {} };
  for (const [selection, value] of Object.entries<any>(extension.responses ?? {})) { const statusCode = String(value?.statusCode ?? (/^\d{3}$/.test(selection) ? selection : "200")); const response: ApiIntegrationResponseState = { statusCode, selectionPattern: selection === "default" ? undefined : value?.selectionPattern ?? selection, responseParameters: clone(value?.responseParameters ?? {}), responseTemplates: clone(value?.responseTemplates ?? {}), contentHandling: value?.contentHandling }; integration.responses![statusCode] = response; }
  return integration;
}
function methodResponses(api: RestApiState, operation: any, swagger: boolean, preferred: string): Record<string, ApiMethodResponseState> {
  const result: Record<string, ApiMethodResponseState> = {};
  for (const [code, definition] of Object.entries<any>(operation.responses ?? {})) { if (!/^\d{3}$/.test(code)) continue; const responseModels: Record<string, string> = {}; if (swagger) { const name = schemaModel(api, definition?.schema, `${preferred}${code}Response`, (operation.produces ?? ["application/json"])[0] ?? "application/json"); if (name) for (const contentType of operation.produces ?? ["application/json"]) responseModels[contentType] = name; } else for (const [contentType, content] of Object.entries<any>(definition?.content ?? {})) { const name = schemaModel(api, content?.schema, `${preferred}${code}Response`, contentType); if (name) responseModels[contentType] = name; }
    result[code] = { statusCode: code, responseParameters: Object.fromEntries(Object.entries<any>(definition?.headers ?? {}).map(([name, value]) => [`method.response.header.${name}`, value?.required === true])), responseModels };
  }
  return result;
}

export function applyOpenApiDocument(base: RestApiState, document: Record<string, any>, mode: "merge" | "overwrite", parameters: Record<string, string> = {}): { api: RestApiState; warnings: string[] } {
  const swagger = document.swagger === "2.0"; const openapi = typeof document.openapi === "string" && /^3\.(?:0|1)\.\d+$/.test(document.openapi); if (!swagger && !openapi) throw new Error("Definition must declare Swagger 2.0 or OpenAPI 3.0/3.1"); if (!object(document.info) || !document.info.title || !document.info.version) throw new Error("OpenAPI info.title and info.version are required"); if (!object(document.paths)) throw new Error("OpenAPI paths must be an object");
  const warnings: string[] = []; const api = clone(base); api.version = String(document.info.version); if (document.info.description !== undefined) api.description = String(document.info.description);
  if (mode === "overwrite") { const root = clone(api.resources[api.rootResourceId]); root.methods = {}; root.integrations = {}; api.resources = { [root.id]: root }; api.authorizers = {}; api.models = defaultApiModels(); api.requestValidators = {}; api.gatewayResponses = {}; api.binaryMediaTypes = []; delete api.minimumCompressionSize; delete api.policy; }
  api.authorizers ??= {}; api.models ??= defaultApiModels(); api.requestValidators ??= {}; api.gatewayResponses ??= {};
  const endpoint = parameters.endpointConfigurationTypes; if (endpoint && endpoint !== "REGIONAL") warnings.push(`Endpoint type ${endpoint} is not available locally; REGIONAL is used`); for (const key of Object.keys(parameters)) if (!["ignore", "endpointConfigurationTypes", "basepath"].includes(key)) warnings.push(`Import parameter ${key} is not supported`);
  if (document["x-amazon-apigateway-binary-media-types"] !== undefined) api.binaryMediaTypes = clone(document["x-amazon-apigateway-binary-media-types"]); if (document["x-amazon-apigateway-minimum-compression-size"] !== undefined) api.minimumCompressionSize = Number(document["x-amazon-apigateway-minimum-compression-size"]); if (document["x-amazon-apigateway-policy"] !== undefined) api.policy = clone(document["x-amazon-apigateway-policy"]); if (document["x-amazon-apigateway-api-key-source"] !== undefined) api.apiKeySource = String(document["x-amazon-apigateway-api-key-source"]).toUpperCase() as "HEADER" | "AUTHORIZER";
  for (const [type, value] of Object.entries<any>(document["x-amazon-apigateway-gateway-responses"] ?? {})) api.gatewayResponses[type] = { responseType: type, statusCode: value.statusCode === undefined ? undefined : String(value.statusCode), responseParameters: clone(value.responseParameters ?? {}), responseTemplates: clone(value.responseTemplates ?? {}) } as ApiGatewayResponseState;
  const schemas = swagger ? document.definitions : document.components?.schemas; for (const [name, schema] of Object.entries<any>(schemas ?? {})) { const modelName = alphanumeric(name); api.models[modelName] = { id: api.models[modelName]?.id ?? id(10), name: modelName, description: schema.description, contentType: "application/json", schema: JSON.stringify(rewriteRefs(schema, api.id)) } as ApiModelState; }
  const validatorNames = new Map<string, string>(); for (const [name, value] of Object.entries<any>(document["x-amazon-apigateway-request-validators"] ?? {})) { const existing = Object.values(api.requestValidators).find(item => item.name === name); const validator: ApiRequestValidatorState = { id: existing?.id ?? id(10), name, validateRequestBody: value.validateRequestBody === true, validateRequestParameters: value.validateRequestParameters === true }; api.requestValidators[validator.id] = validator; validatorNames.set(name, validator.id); }
  const authorizers = importedAuthorizers(document, api, warnings); const securityDefinitions = swagger ? document.securityDefinitions : document.components?.securitySchemes; const apiKeySecurityNames = new Set(Object.entries<any>(securityDefinitions ?? {}).filter(([, definition]) => definition?.type === "apiKey" && !definition?.["x-amazon-apigateway-authorizer"]).map(([name]) => name)); const globalParameters = Array.isArray(document.parameters) ? document.parameters : [];
  let prefix = ""; if (["prepend", "split"].includes(parameters.basepath)) { const basePath = swagger ? document.basePath : (() => { try { return new URL(document.servers?.[0]?.url ?? "http://local/").pathname; } catch { return ""; } })(); prefix = `/${String(basePath ?? "").split("/").filter(Boolean).join("/")}`.replace(/^\/$/, ""); }
  for (const [sourcePath, pathItem] of Object.entries<any>(document.paths)) {
    if (!sourcePath.startsWith("/") || !object(pathItem)) throw new Error(`Invalid OpenAPI path: ${sourcePath}`); const resource = ensureResource(api, `${prefix}${sourcePath}`); const pathParameters = [...globalParameters, ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : [])];
    for (const [sourceMethod, operation] of Object.entries<any>(pathItem)) {
      if (!HTTP_METHODS.has(sourceMethod.toLowerCase()) || !object(operation)) continue; const methodName = sourceMethod.toLowerCase() === "x-amazon-apigateway-any-method" ? "ANY" : sourceMethod.toUpperCase(); const preferred = alphanumeric(operation.operationId ?? `${methodName}${sourcePath}`); const allParameters = [...pathParameters, ...(Array.isArray(operation.parameters) ? operation.parameters : [])]; const requestModels: Record<string, string> = clone(operation["x-amazon-apigateway-request-models"] ?? {});
      if (swagger) { const body = allParameters.find(value => value?.in === "body"); if (body?.schema) { const name = schemaModel(api, body.schema, `${preferred}Request`, (operation.consumes ?? document.consumes ?? ["application/json"])[0]); if (name) for (const contentType of operation.consumes ?? document.consumes ?? ["application/json"]) requestModels[contentType] = name; } }
      else for (const [contentType, content] of Object.entries<any>(operation.requestBody?.content ?? {})) { const name = schemaModel(api, content?.schema, `${preferred}Request`, contentType); if (name) requestModels[contentType] = name; }
      let authorizationType = "NONE"; let authorizerId: string | undefined; let authorizationScopes: string[] = []; const securityRequirements = (operation.security ?? document.security ?? []) as any[]; const securityNames = new Set<string>(securityRequirements.flatMap((requirement: any) => Object.keys(requirement ?? {}))); const authorizerName = [...securityNames].find(name => authorizers.has(name)); if (authorizerName) { const authorizer = authorizers.get(authorizerName)!; authorizationType = authorizer.type === "COGNITO_USER_POOLS" ? "COGNITO_USER_POOLS" : "CUSTOM"; authorizerId = authorizer.id; const requirement = securityRequirements.find(value => Object.prototype.hasOwnProperty.call(value ?? {}, authorizerName)); authorizationScopes = Array.isArray(requirement?.[authorizerName]) ? requirement[authorizerName].map(String) : []; }
      const validatorName = operation["x-amazon-apigateway-request-validator"] ?? document["x-amazon-apigateway-request-validator"]; const method: ApiMethodState = { authorizationType, authorizerId, authorizationScopes, apiKeyRequired: [...securityNames].some(name => apiKeySecurityNames.has(name)), requestParameters: parameterMap(allParameters), requestModels, requestValidatorId: validatorName ? validatorNames.get(String(validatorName)) : undefined, operationName: operation.operationId, responses: methodResponses(api, { ...operation, produces: operation.produces ?? document.produces }, swagger, preferred) }; if (validatorName && !method.requestValidatorId) warnings.push(`Method ${methodName} ${sourcePath} refers to unknown request validator ${String(validatorName)}`); resource.methods[methodName] = method;
      const integration = integrationState(operation["x-amazon-apigateway-integration"], methodName, warnings); if (integration) resource.integrations[methodName] = integration; else if (mode === "overwrite") delete resource.integrations[methodName];
    }
  }
  return { api, warnings };
}

function exportSchema(model: ApiModelState, swagger: boolean): any { const schema = JSON.parse(model.schema); const rewrite = (value: any): any => { if (Array.isArray(value)) return value.map(rewrite); if (!object(value)) return value; return Object.fromEntries(Object.entries(value).map(([key, child]) => { if (key === "$ref" && typeof child === "string") { const name = child.match(/\/models\/([^/#?]+)$/)?.[1]; if (name) return [key, swagger ? `#/definitions/${decodeURIComponent(name)}` : `#/components/schemas/${decodeURIComponent(name)}`]; } return [key, rewrite(child)]; })); }; return rewrite(schema); }
function modelReference(name: string, swagger: boolean): any { return { $ref: swagger ? `#/definitions/${name}` : `#/components/schemas/${name}` }; }
function exportIntegration(integration: ApiIntegrationState): any { return { type: integration.type.toLowerCase(), httpMethod: integration.integrationHttpMethod, uri: integration.uri, connectionType: integration.connectionType ?? "INTERNET", connectionId: integration.connectionId, credentials: integration.credentials, requestParameters: integration.requestParameters, requestTemplates: integration.requestTemplates, passthroughBehavior: integration.passthroughBehavior?.toLowerCase(), contentHandling: integration.contentHandling, timeoutInMillis: integration.timeoutInMillis, cacheNamespace: integration.cacheNamespace, cacheKeyParameters: integration.cacheKeyParameters, tlsConfig: integration.tlsConfig === undefined ? undefined : clone(integration.tlsConfig), responses: Object.fromEntries(Object.values(integration.responses ?? {}).map(response => [response.selectionPattern ?? "default", { statusCode: response.statusCode, responseParameters: response.responseParameters, responseTemplates: response.responseTemplates, contentHandling: response.contentHandling }])) }; }

export function exportOpenApi(api: RestApiState, snapshot: ApiDeploymentSnapshot, exportType: "swagger" | "oas30", extensions: Set<string>, postman: boolean): Record<string, any> {
  const swagger = exportType === "swagger"; const document: Record<string, any> = swagger ? { swagger: "2.0", info: { title: api.name, description: api.description, version: api.version ?? "1.0" }, schemes: ["http"], paths: {}, definitions: {} } : { openapi: "3.0.1", info: { title: api.name, description: api.description, version: api.version ?? "1.0" }, servers: [{ url: `http://localhost/{basePath}`, variables: { basePath: { default: "" } } }], paths: {}, components: { schemas: {}, securitySchemes: {} } };
  const includeIntegrations = extensions.has("integrations") || extensions.has("apigateway"); const includeAuthorizers = extensions.has("authorizers") || extensions.has("apigateway"); const models = snapshot.models ?? {};
  const targetSchemas = swagger ? document.definitions : document.components.schemas; for (const [name, model] of Object.entries(models)) targetSchemas[name] = exportSchema(model, swagger);
  if (Object.values(snapshot.resources).some(resource => Object.values(resource.methods).some(method => method.apiKeyRequired))) { const definition = { type: "apiKey", name: "X-API-Key", in: "header" }; if (swagger) (document.securityDefinitions ??= {}).api_key = definition; else document.components.securitySchemes.api_key = definition; }
  const authorizerNames = new Map<string, string>(); if (includeAuthorizers) for (const authorizer of Object.values(snapshot.authorizers ?? {})) { const name = alphanumeric(authorizer.name); authorizerNames.set(authorizer.id, name); const definition: any = { type: "apiKey", name: authorizer.identitySource?.match(/header\.([^, ]+)/)?.[1] ?? "Authorization", in: "header", ...(authorizer.type === "COGNITO_USER_POOLS" ? { "x-amazon-apigateway-authtype": "cognito_user_pools" } : {}), "x-amazon-apigateway-authorizer": { type: authorizer.type.toLowerCase(), authorizerUri: authorizer.authorizerUri, authorizerCredentials: authorizer.authorizerCredentials, identitySource: authorizer.identitySource, identityValidationExpression: authorizer.identityValidationExpression, authorizerResultTtlInSeconds: authorizer.authorizerResultTtlInSeconds, providerARNs: authorizer.providerARNs ? [...authorizer.providerARNs] : undefined } }; if (swagger) (document.securityDefinitions ??= {})[name] = definition; else document.components.securitySchemes[name] = definition; }
  for (const resource of Object.values(snapshot.resources).filter(value => Object.keys(value.methods).length > 0).sort((a, b) => a.path.localeCompare(b.path))) {
    const path: Record<string, any> = document.paths[resource.path] ??= {};
    for (const [methodName, method] of Object.entries(resource.methods)) { const operation: Record<string, any> = { operationId: method.operationName, parameters: [], responses: {} }; for (const [parameter, required] of Object.entries(method.requestParameters ?? {})) { const [, , location, name] = parameter.split("."); operation.parameters.push({ name, in: location === "querystring" ? "query" : location, required, ...(swagger ? { type: "string" } : { schema: { type: "string" } }) }); }
      for (const [contentType, name] of Object.entries(method.requestModels ?? {})) if (swagger) { operation.consumes ??= []; if (!operation.consumes.includes(contentType)) operation.consumes.push(contentType); if (!operation.parameters.some((value: any) => value.in === "body")) operation.parameters.push({ name: "body", in: "body", required: true, schema: modelReference(name, true) }); } else { operation.requestBody ??= { required: true, content: {} }; operation.requestBody.content[contentType] = { schema: modelReference(name, false) }; }
      for (const [code, response] of Object.entries(method.responses ?? {})) { const definition: any = { description: `Response ${code}`, headers: Object.fromEntries(Object.entries(response.responseParameters ?? {}).map(([name, required]) => [name.replace(/^method\.response\.header\./, ""), swagger ? { type: "string", required } : { schema: { type: "string" }, required }])) }; for (const [contentType, name] of Object.entries(response.responseModels ?? {})) if (swagger) { operation.produces ??= []; if (!operation.produces.includes(contentType)) operation.produces.push(contentType); definition.schema ??= modelReference(name, true); } else { definition.content ??= {}; definition.content[contentType] = { schema: modelReference(name, false) }; } operation.responses[code] = definition; }
      if (!Object.keys(operation.responses).length) operation.responses.default = { description: "Default response" }; if (method.requestValidatorId) operation["x-amazon-apigateway-request-validator"] = snapshot.requestValidators?.[method.requestValidatorId]?.name; if (includeIntegrations && resource.integrations[methodName]) operation["x-amazon-apigateway-integration"] = exportIntegration(resource.integrations[methodName]); const security: Record<string, string[]> = {}; if (includeAuthorizers && method.authorizerId && authorizerNames.has(method.authorizerId)) security[authorizerNames.get(method.authorizerId)!] = [...(method.authorizationScopes ?? [])]; if (method.apiKeyRequired) security.api_key = []; if (Object.keys(security).length) operation.security = [security]; path[methodName === "ANY" ? "x-amazon-apigateway-any-method" : methodName.toLowerCase()] = operation;
    }
  }
  if (extensions.has("apigateway")) { document["x-amazon-apigateway-binary-media-types"] = snapshot.binaryMediaTypes ?? []; if (snapshot.minimumCompressionSize !== undefined) document["x-amazon-apigateway-minimum-compression-size"] = snapshot.minimumCompressionSize; if (snapshot.policy) document["x-amazon-apigateway-policy"] = snapshot.policy; document["x-amazon-apigateway-api-key-source"] = snapshot.apiKeySource ?? api.apiKeySource ?? "HEADER"; document["x-amazon-apigateway-request-validators"] = Object.fromEntries(Object.values(snapshot.requestValidators ?? {}).map(value => [value.name ?? value.id, { validateRequestBody: value.validateRequestBody, validateRequestParameters: value.validateRequestParameters }])); document["x-amazon-apigateway-gateway-responses"] = Object.fromEntries(Object.entries(snapshot.gatewayResponses ?? {}).map(([name, value]) => [name, { statusCode: value.statusCode, responseParameters: value.responseParameters, responseTemplates: value.responseTemplates }])); }
  if (postman) { document["x-postman-name"] = api.name; document["x-postman-description"] = api.description ?? ""; }
  return document;
}

function yamlKey(value: string): string { return /^[A-Za-z0-9_$.-]+$/.test(value) ? value : JSON.stringify(value); }
function yamlValue(value: unknown, indent: number): string[] {
  const prefix = " ".repeat(indent); if (Array.isArray(value)) { if (!value.length) return [`${prefix}[]`]; const result: string[] = []; for (const item of value) { if (Array.isArray(item) && !item.length) result.push(`${prefix}- []`); else if (object(item) && !Object.keys(item).length) result.push(`${prefix}- {}`); else if (object(item) || Array.isArray(item)) { result.push(`${prefix}-`); result.push(...yamlValue(item, indent + 2)); } else result.push(`${prefix}- ${JSON.stringify(item)}`); } return result; }
  if (object(value)) { if (!Object.keys(value).length) return [`${prefix}{}`]; const result: string[] = []; for (const [key, child] of Object.entries(value)) { if (Array.isArray(child) && !child.length) result.push(`${prefix}${yamlKey(key)}: []`); else if (object(child) && !Object.keys(child).length) result.push(`${prefix}${yamlKey(key)}: {}`); else if (object(child) || Array.isArray(child)) { result.push(`${prefix}${yamlKey(key)}:`); result.push(...yamlValue(child, indent + 2)); } else if (child !== undefined) result.push(`${prefix}${yamlKey(key)}: ${JSON.stringify(child)}`); } return result; }
  return [`${prefix}${JSON.stringify(value)}`];
}
export function stringifyOpenApiYaml(document: Record<string, any>): string { return `${yamlValue(document, 0).join("\n")}\n`; }
