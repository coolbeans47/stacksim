import { isObject, shorthand, type JsonObject } from "./common.js";

export const X_INTEGRATION = "x-amazon-apigateway-integration";
export const X_ANY_METHOD = "x-amazon-apigateway-any-method";
export const HTTP_DEFAULT_PATH = "$default";

const OPENAPI_3 = /^3(\.\d)(\.\d)?$/;
const SUPPORTED_REST_VERSION = /^[2-3](\.\d)(\.\d)?$/;

export const isOpenApi3Version = (value: unknown): boolean => typeof value === "string" && OPENAPI_3.test(value);
export const isSupportedRestOpenApiVersion = (value: unknown): boolean => typeof value === "string" && SUPPORTED_REST_VERSION.test(value);

export function swaggerSkeleton(): JsonObject {
  return { swagger: "2.0", info: { version: "1.0", title: { Ref: "AWS::StackName" } }, paths: {} };
}

export function openApiSkeleton(): JsonObject {
  return { openapi: "3.0.1", info: { version: "1.0", title: { Ref: "AWS::StackName" } }, paths: {} };
}

/** SwaggerEditor.is_valid: a swagger document, or an OpenAPI 3 document. */
export function isSwaggerDocument(body: unknown): body is JsonObject & { paths: JsonObject } {
  if (!isObject(body) || !isObject(body.paths)) return false;
  if (body.swagger) return true;
  return Boolean(body.openapi) && isOpenApi3Version(body.openapi);
}

/** OpenApiEditor.is_valid: an OpenAPI 3 document. */
export function isOpenApiDocument(body: unknown): body is JsonObject & { paths: JsonObject } {
  return isObject(body) && isObject(body.paths) && Boolean(body.openapi) && isOpenApi3Version(body.openapi);
}

export function normalizeMethod(method: unknown): unknown {
  if (typeof method !== "string" || !method) return method;
  const lower = method.toLowerCase();
  return lower === "any" ? X_ANY_METHOD : lower;
}

export function pathItem(body: JsonObject, path: string): JsonObject {
  const paths = body.paths as JsonObject;
  const item = paths[path] ?? (paths[path] = {});
  if (!isObject(item)) throw new Error(`Value of '${path}' path must be a dictionary according to Swagger spec.`);
  return item;
}

export function addPath(body: JsonObject, path: string, method: string): void {
  const item = pathItem(body, path);
  const normalized = normalizeMethod(method) as string;
  if (item[normalized] === undefined || item[normalized] === null) item[normalized] = {};
}

export function hasIntegration(body: JsonObject, path: string, method: string): boolean {
  const item = isObject(body.paths) ? body.paths[path] : undefined;
  const definition = isObject(item) ? item[normalizeMethod(method) as string] : undefined;
  return isObject(definition) && Boolean(definition[X_INTEGRATION]);
}

/**
 * The path in a Lambda permission SourceArn: no trailing slash, and path
 * parameters (greedy or not) replaced by `*`.
 */
export function permissionPath(path: string, greedyParameters: boolean): string {
  const trimmed = path.replace(/^(.+)\/$/, "$1");
  return trimmed.replace(greedyParameters ? /\{([a-zA-Z0-9._-]+|[a-zA-Z0-9._-]+\+|proxy\+)\}/g : /\{([a-zA-Z0-9._-]+|proxy\+)\}/g, "*");
}

/** _build_apigw_integration_uri: the function's (or its alias's) ARN in shorthand inside Fn::Sub. */
export function lambdaIntegrationUri(partition: string, functionArn: JsonObject): JsonObject {
  return { "Fn::Sub": `arn:${partition}:apigateway:\${AWS::Region}:lambda:path/2015-03-31/functions/${shorthand(functionArn)}/invocations` };
}
