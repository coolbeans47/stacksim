import { AwsError } from "../errors.js";
import { SearchError } from "../opensearch/query.js";
import type { AppSyncDataSourceState, AppSyncGraphqlApiState, AppSyncResolverState } from "../types.js";
import { AppSyncVtlError, evaluateAppSyncVtl, validateAppSyncVtl, type AppSyncVtlContext, type AppSyncVtlEvaluation } from "./vtl.js";

export interface AppSyncOpenSearchPort {
  validate(api: AppSyncGraphqlApiState, roleArn: string, config: { endpoint: string; awsRegion: string }): Promise<void>;
  request(api: AppSyncGraphqlApiState, source: AppSyncDataSourceState, method: string, path: string, body?: Record<string, unknown>): Promise<unknown>;
}
function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppSyncVtlError(`${label} must be an object`, "MappingTemplate");
  return value as Record<string, any>;
}
function members(value: Record<string, any>, allowed: string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new AppSyncVtlError(`${label} has an unsupported member`, "MappingTemplate");
}
function requestDocument(value: unknown): { method: string; path: string; body?: Record<string, unknown> } {
  const request = object(value, "OpenSearch request"); members(request, ["version", "operation", "path", "params"], "OpenSearch request");
  if (request.version !== "2017-02-28") throw new AppSyncVtlError("OpenSearch request version must be 2017-02-28", "MappingTemplate");
  if (!["GET", "POST", "PUT", "HEAD", "DELETE"].includes(request.operation)) throw new AppSyncVtlError("Unsupported OpenSearch request operation", "MappingTemplate");
  if (typeof request.path !== "string" || !request.path.startsWith("/") || request.path.startsWith("//") || /[?#\\]/.test(request.path) || request.path.length > 4096 || new URL(request.path, "https://localhost").pathname !== request.path) throw new AppSyncVtlError("OpenSearch path must be an absolute resource path without query or fragment", "MappingTemplate");
  const params = object(request.params ?? {}, "OpenSearch params"); members(params, ["headers", "queryString", "body"], "OpenSearch params");
  const headers = object(params.headers ?? {}, "OpenSearch headers");
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() !== "content-type" || value !== "application/json") throw new AppSyncVtlError("Only an application/json Content-Type header is supported", "MappingTemplate");
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(object(params.queryString ?? {}, "OpenSearch queryString"))) { if (typeof value !== "string") throw new AppSyncVtlError("OpenSearch queryString values must be strings", "MappingTemplate"); query.append(key, value); }
  const body = params.body === undefined ? undefined : object(params.body, "OpenSearch body");
  if (body !== undefined && Buffer.byteLength(JSON.stringify(body)) > 1024 * 1024) throw new AppSyncVtlError("OpenSearch resolver bodies must not exceed 1 MiB", "MappingTemplate");
  return { method: request.operation, path: `${request.path}${query.size ? `?${query}` : ""}`, ...(body === undefined ? {} : { body }) };
}
export function validateOpenSearchResolverTemplates(request: string, response: string): void {
  try { validateAppSyncVtl(request); validateAppSyncVtl(response); if (!request.includes("$") && !request.includes("#")) requestDocument(JSON.parse(request)); }
  catch (error) { throw new AwsError("BadRequestException", error instanceof Error ? error.message : "Invalid OpenSearch resolver template", 400); }
}
export async function executeOpenSearchResolver(port: AppSyncOpenSearchPort, api: AppSyncGraphqlApiState, resolver: Pick<AppSyncResolverState, "requestMappingTemplate" | "responseMappingTemplate">, source: AppSyncDataSourceState, context: Omit<AppSyncVtlContext, "result" | "error">, now: number): Promise<AppSyncVtlEvaluation> {
  const request = evaluateAppSyncVtl(resolver.requestMappingTemplate, context, now); if (request.returned) return request;
  const document = requestDocument(request.value); let result: unknown = null, error: { message: string; type: string } | null = null;
  try { result = await port.request(api, source, document.method, document.path, document.body); }
  catch (failure) { error = { message: failure instanceof AwsError || failure instanceof SearchError ? failure.message : "OpenSearch data source is unavailable", type: failure instanceof AwsError ? failure.code : failure instanceof SearchError ? failure.type : "InternalFailure" }; }
  const response = evaluateAppSyncVtl(resolver.responseMappingTemplate, { ...context, result, error }, now);
  return { ...response, appendedErrors: [...request.appendedErrors, ...response.appendedErrors], logs: [...request.logs, ...response.logs] };
}
