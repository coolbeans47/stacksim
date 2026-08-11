import type { IncomingMessage, ServerResponse } from "node:http";
import type { Clock } from "./core/clock.js";
import { PaginationTokens } from "./core/pagination.js";
import { AwsError, sendAwsError } from "./errors.js";
import { writeWithBackpressure } from "./protocols/event-stream.js";
import type { StateStore } from "./state.js";
import type { LambdaFunctionUrlConfigState, LambdaFunctionUrlCorsState, LambdaState } from "./types.js";
import { id, json, readBody } from "./util.js";

export interface LambdaUrlInvokeResult {
  payload: Buffer;
  functionError?: string;
  statusCode: number;
  logResult?: string;
  requestId: string;
  durationMs: number;
  billedDurationMs: number;
  executedVersion: string;
}

export interface LambdaStreamCallbacks {
  onStart?(value: { requestId: string; executedVersion: string }): void | Promise<void>;
  onMetadata?(metadata: Record<string, unknown>): void | Promise<void>;
  onChunk(chunk: Buffer): void | Promise<void>;
}

interface ResolvedUrlFunction { fn: LambdaState; requestedQualifier?: string; qualifiedArn: string }
interface FunctionUrlHooks {
  resolve(functionName: string, qualifier?: string): ResolvedUrlFunction;
  invoke(functionName: string, payload: Buffer, requestId: string, qualifier?: string, lineage?: string[]): Promise<LambdaUrlInvokeResult>;
  invokeStreaming(functionName: string, payload: Buffer, requestId: string, qualifier: string | undefined, callbacks: LambdaStreamCallbacks, lineage?: string[]): Promise<LambdaUrlInvokeResult>;
  publishMetric(functionName: string, metricName: string, value?: number): Promise<void>;
}

export interface FunctionUrlTarget {
  functionName: string;
  functionArn: string;
  config: LambdaFunctionUrlConfigState;
}

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "*"]);
const FORBIDDEN_RESPONSE_HEADERS = new Set(["connection", "content-length", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

function parseJson(body: Buffer): any {
  try { return body.length ? JSON.parse(body.toString("utf8")) : {}; }
  catch { throw new AwsError("InvalidRequestContentException", "Could not parse request body into JSON", 400); }
}

function optionalStringArray(value: unknown, name: string, maximum: number, memberMaximum: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximum || value.some(item => typeof item !== "string" || item.length > memberMaximum)) throw new AwsError("InvalidParameterValueException", `${name} must contain at most ${maximum} strings of at most ${memberMaximum} characters`);
  return [...value];
}

function validateCors(value: unknown): LambdaFunctionUrlCorsState | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AwsError("InvalidParameterValueException", "Cors must be an object");
  const input = value as any; const allowHeaders = optionalStringArray(input.AllowHeaders, "AllowHeaders", 100, 1024); const allowMethods = optionalStringArray(input.AllowMethods, "AllowMethods", 6, 6); const allowOrigins = optionalStringArray(input.AllowOrigins, "AllowOrigins", 100, 253); const exposeHeaders = optionalStringArray(input.ExposeHeaders, "ExposeHeaders", 100, 1024);
  if (allowMethods?.some(method => !METHODS.has(method.toUpperCase())) || (allowMethods?.includes("*") && allowMethods.length > 1)) throw new AwsError("InvalidParameterValueException", "AllowMethods contains an invalid method or combines * with other methods");
  if (allowOrigins?.some(origin => origin !== "*" && !/^https?:\/\/[^\s/]+(?::\d+)?$/.test(origin))) throw new AwsError("InvalidParameterValueException", "AllowOrigins entries must be * or HTTP(S) origins without paths");
  if (input.AllowCredentials !== undefined && typeof input.AllowCredentials !== "boolean") throw new AwsError("InvalidParameterValueException", "AllowCredentials must be a boolean");
  if (input.AllowCredentials && allowOrigins?.includes("*")) throw new AwsError("InvalidParameterValueException", "AllowCredentials cannot be combined with a wildcard origin");
  if (input.MaxAge !== undefined && (!Number.isInteger(input.MaxAge) || input.MaxAge < 0 || input.MaxAge > 86_400)) throw new AwsError("InvalidParameterValueException", "MaxAge must be between 0 and 86400");
  const result: LambdaFunctionUrlCorsState = { ...(input.AllowCredentials !== undefined ? { allowCredentials: input.AllowCredentials } : {}), ...(allowHeaders ? { allowHeaders } : {}), ...(allowMethods ? { allowMethods: allowMethods.map(method => method.toUpperCase()) } : {}), ...(allowOrigins ? { allowOrigins } : {}), ...(exposeHeaders ? { exposeHeaders } : {}), ...(input.MaxAge !== undefined ? { maxAge: input.MaxAge } : {}) };
  return Object.keys(result).length ? result : undefined;
}

function corsView(cors?: LambdaFunctionUrlCorsState): any {
  if (!cors) return undefined;
  return { ...(cors.allowCredentials !== undefined ? { AllowCredentials: cors.allowCredentials } : {}), ...(cors.allowHeaders ? { AllowHeaders: cors.allowHeaders } : {}), ...(cors.allowMethods ? { AllowMethods: cors.allowMethods } : {}), ...(cors.allowOrigins ? { AllowOrigins: cors.allowOrigins } : {}), ...(cors.exposeHeaders ? { ExposeHeaders: cors.exposeHeaders } : {}), ...(cors.maxAge !== undefined ? { MaxAge: cors.maxAge } : {}) };
}

function queryParameters(url: URL): Record<string, string> | null {
  const output: Record<string, string[]> = {};
  for (const [key, value] of url.searchParams) (output[key] ??= []).push(value);
  return Object.keys(output).length ? Object.fromEntries(Object.entries(output).map(([key, values]) => [key, values.join(",")])) : null;
}

function requestHeaders(req: IncomingMessage): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) output[name.toLowerCase()] = Array.isArray(value) ? value.join(",") : String(value);
  return output;
}

function textualContentType(value: string): boolean {
  const type = value.split(";", 1)[0].trim().toLowerCase();
  return !type || type.startsWith("text/") || type.endsWith("+json") || type.endsWith("+xml") || new Set(["application/json", "application/xml", "application/javascript", "application/x-www-form-urlencoded"]).has(type);
}

function requestTime(timestamp: number): string {
  const date = new Date(timestamp);
  const day = String(date.getUTCDate()).padStart(2, "0");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${day}/${months[date.getUTCMonth()]}/${date.getUTCFullYear()}:${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(2, "0")} +0000`;
}

function validateResponseHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AwsError("Runtime.MalformedResponse", "Response headers must be a string map", 502);
  const output: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value as object)) {
    const lower = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || FORBIDDEN_RESPONSE_HEADERS.has(lower) || typeof headerValue !== "string" || /[\r\n]/.test(headerValue)) throw new AwsError("Runtime.MalformedResponse", `Invalid response header: ${name}`, 502);
    output[lower] = headerValue;
  }
  return output;
}

function validateCookies(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(cookie => typeof cookie !== "string" || /[\r\n]/.test(cookie))) throw new AwsError("Runtime.MalformedResponse", "Response cookies must be an array of strings", 502);
  return value;
}

export function validateStreamingResponseMetadata(value: Record<string, unknown>): { statusCode: number; headers: Record<string, string>; cookies: string[] } {
  const statusCode = value.statusCode === undefined ? 200 : Number(value.statusCode);
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) throw new AwsError("Runtime.MalformedResponse", "Response statusCode must be an integer between 100 and 599", 502);
  return { statusCode, headers: validateResponseHeaders(value.headers), cookies: validateCookies(value.cookies) };
}

function setHeaders(res: ServerResponse, headers: Record<string, string>, cookies: string[]): void {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  if (cookies.length) res.setHeader("set-cookie", cookies);
}

function applyCors(req: IncomingMessage, res: ServerResponse, cors?: LambdaFunctionUrlCorsState, preflight = false): void {
  if (!cors) return; const origin = String(req.headers.origin ?? ""); const allowedOrigin = cors.allowOrigins?.includes("*") ? "*" : cors.allowOrigins?.includes(origin) ? origin : undefined;
  if (allowedOrigin) res.setHeader("access-control-allow-origin", allowedOrigin);
  if (cors.allowCredentials) res.setHeader("access-control-allow-credentials", "true");
  if (preflight) {
    if (cors.allowMethods?.length) res.setHeader("access-control-allow-methods", cors.allowMethods.join(","));
    if (cors.allowHeaders?.length) res.setHeader("access-control-allow-headers", cors.allowHeaders.join(","));
    if (cors.maxAge !== undefined) res.setHeader("access-control-max-age", String(cors.maxAge));
  } else if (cors.exposeHeaders?.length) res.setHeader("access-control-expose-headers", cors.exposeHeaders.join(","));
  if (allowedOrigin && allowedOrigin !== "*") res.setHeader("vary", "origin");
}

export class LambdaFunctionUrls {
  constructor(private readonly store: StateStore, private readonly region: string, private readonly clock: Clock, private readonly endpoint: () => string, private readonly hooks: FunctionUrlHooks) {}
  private get tokens(): PaginationTokens { return new PaginationTokens(this.store.state.installation.paginationSecret); }

  private target(functionName: string, explicitQualifier?: string | null): ResolvedUrlFunction {
    const resolved = this.hooks.resolve(functionName, explicitQualifier ?? undefined); const qualifier = resolved.requestedQualifier;
    if (qualifier && (qualifier === "$LATEST" || /^\d+$/.test(qualifier))) throw new AwsError("InvalidParameterValueException", "Function URLs can target only $LATEST implicitly or an alias", 400);
    return resolved;
  }

  private key(qualifier?: string): string { return qualifier ?? ""; }
  private url(config: LambdaFunctionUrlConfigState): string { return `${this.endpoint().replace(/\/$/, "")}/lambda-url/${config.urlId}/`; }
  private view(fn: LambdaState, config: LambdaFunctionUrlConfigState, includeLastModified = true): any {
    return { FunctionUrl: this.url(config), FunctionArn: config.qualifier ? `${fn.functionArn}:${config.qualifier}` : fn.functionArn, AuthType: config.authType, CreationTime: config.creationTime, ...(includeLastModified ? { LastModifiedTime: config.lastModifiedTime } : {}), ...(config.cors ? { Cors: corsView(config.cors) } : {}), InvokeMode: config.invokeMode };
  }

  private uniqueUrlId(): string {
    for (;;) { const candidate = id(32); if (!this.find(candidate)) return candidate; }
  }

  async handleControl(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<boolean> {
    const single = pathname.match(/^\/2021-10-31\/functions\/([^/]+)\/url$/); const list = pathname.match(/^\/2021-10-31\/functions\/([^/]+)\/urls$/); if (!single && !list) return false;
    try {
      const encoded = (single ?? list)![1]; const resolved = this.target(decodeURIComponent(encoded), single ? url.searchParams.get("Qualifier") : undefined); const fn = resolved.fn; fn.functionUrlConfigs ??= {};
      if (list) {
        if (req.method !== "GET") throw new AwsError("ResourceNotFoundException", "Unknown Lambda route", 404);
        const requestedMax = Number(url.searchParams.get("MaxItems") ?? 50); if (!Number.isInteger(requestedMax) || requestedMax < 1 || requestedMax > 50) throw new AwsError("InvalidParameterValueException", "MaxItems must be between 1 and 50"); const values = Object.values(fn.functionUrlConfigs).sort((left, right) => this.key(left.qualifier).localeCompare(this.key(right.qualifier))); let start = 0; const marker = url.searchParams.get("Marker");
        if (marker) try { const cursor = this.tokens.decode<{ functionName: string; index: number }>("ListFunctionUrlConfigs", marker); if (cursor.functionName !== fn.functionName || !Number.isInteger(cursor.index) || cursor.index < 0) throw new Error(); start = cursor.index; } catch { throw new AwsError("InvalidParameterValueException", "Invalid Marker"); }
        const page = values.slice(start, start + requestedMax); const next = start + page.length; json(res, { FunctionUrlConfigs: page.map(config => this.view(fn, config)), ...(next < values.length ? { NextMarker: this.tokens.encode("ListFunctionUrlConfigs", { functionName: fn.functionName, index: next }) } : {}) }); return true;
      }
      const key = this.key(resolved.requestedQualifier); const existing = fn.functionUrlConfigs[key];
      if (req.method === "POST") {
        if (existing) throw new AwsError("ResourceConflictException", "A function URL configuration already exists for this function and qualifier", 409); const input = parseJson(await readBody(req)); if (!new Set(["NONE", "AWS_IAM"]).has(input.AuthType)) throw new AwsError("InvalidParameterValueException", "AuthType must be NONE or AWS_IAM"); const invokeMode = input.InvokeMode ?? "BUFFERED"; if (!new Set(["BUFFERED", "RESPONSE_STREAM"]).has(invokeMode)) throw new AwsError("InvalidParameterValueException", "InvokeMode must be BUFFERED or RESPONSE_STREAM"); const cors = validateCors(input.Cors); const now = new Date(this.clock.now()).toISOString(); const config: LambdaFunctionUrlConfigState = { urlId: this.uniqueUrlId(), ...(resolved.requestedQualifier ? { qualifier: resolved.requestedQualifier } : {}), authType: input.AuthType, ...(cors ? { cors } : {}), invokeMode, creationTime: now, lastModifiedTime: now }; fn.functionUrlConfigs[key] = config; await this.store.save(); json(res, this.view(fn, config, false), 201); return true;
      }
      if (!existing) throw new AwsError("ResourceNotFoundException", "The function URL configuration does not exist", 404);
      if (req.method === "GET") { json(res, this.view(fn, existing)); return true; }
      if (req.method === "DELETE") { delete fn.functionUrlConfigs[key]; await this.store.save(); res.statusCode = 204; res.end(); return true; }
      if (req.method === "PUT") {
        const input = parseJson(await readBody(req)); if (input.AuthType !== undefined && !new Set(["NONE", "AWS_IAM"]).has(input.AuthType)) throw new AwsError("InvalidParameterValueException", "AuthType must be NONE or AWS_IAM"); if (input.InvokeMode !== undefined && !new Set(["BUFFERED", "RESPONSE_STREAM"]).has(input.InvokeMode)) throw new AwsError("InvalidParameterValueException", "InvokeMode must be BUFFERED or RESPONSE_STREAM"); if (input.AuthType !== undefined) existing.authType = input.AuthType; if (input.InvokeMode !== undefined) existing.invokeMode = input.InvokeMode; if (input.Cors !== undefined) existing.cors = validateCors(input.Cors); existing.lastModifiedTime = new Date(this.clock.now()).toISOString(); await this.store.save(); json(res, this.view(fn, existing)); return true;
      }
      throw new AwsError("ResourceNotFoundException", "Unknown Lambda route", 404);
    } catch (error) { sendAwsError(res, error, "rest"); return true; }
  }

  find(urlId: string): FunctionUrlTarget | undefined {
    for (const fn of Object.values(this.store.regionState(this.region).functions)) for (const config of Object.values(fn.functionUrlConfigs ?? {})) if (config.urlId === urlId) return { functionName: fn.functionName, functionArn: config.qualifier ? `${fn.functionArn}:${config.qualifier}` : fn.functionArn, config };
    return undefined;
  }

  isPreflight(req: IncomingMessage): boolean { return req.method === "OPTIONS" && Boolean(req.headers.origin) && Boolean(req.headers["access-control-request-method"]); }
  preflight(req: IncomingMessage, res: ServerResponse, target: FunctionUrlTarget): void { res.statusCode = 204; applyCors(req, res, target.config.cors, true); res.end(); }

  private async event(req: IncomingMessage, url: URL, target: FunctionUrlTarget, rawPath: string, requestId: string, principal?: import("./auth/sigv4.js").PrincipalContext): Promise<Buffer> {
    const body = await readBody(req); if (body.length > 6 * 1024 * 1024) throw new AwsError("RequestTooLargeException", "Function URL request payload exceeds 6 MB", 413); const headers = requestHeaders(req); const binary = body.length > 0 && !textualContentType(headers["content-type"] ?? ""); const now = this.clock.now(); const sourceIp = req.socket.remoteAddress?.replace(/^::ffff:/, "") ?? "127.0.0.1"; const event = { version: "2.0", routeKey: "$default", rawPath, rawQueryString: url.search.slice(1), cookies: headers.cookie ? headers.cookie.split(";").map(cookie => cookie.trim()).filter(Boolean) : undefined, headers, queryStringParameters: queryParameters(url), requestContext: { accountId: this.store.accountId, apiId: target.config.urlId, authentication: null, authorizer: principal ? { iam: { accessKey: principal.accessKeyId, accountId: principal.accountId, callerId: principal.principalId, cognitoIdentity: null, principalOrgId: null, userArn: principal.principalArn, userId: principal.principalId } } : null, domainName: String(req.headers.host ?? "localhost"), domainPrefix: target.config.urlId, http: { method: req.method ?? "GET", path: rawPath, protocol: `HTTP/${req.httpVersion}`, sourceIp, userAgent: headers["user-agent"] ?? "" }, requestId, routeKey: "$default", stage: "$default", time: requestTime(now), timeEpoch: now }, body: body.length ? binary ? body.toString("base64") : body.toString("utf8") : null, pathParameters: null, isBase64Encoded: binary, stageVariables: null };
    return Buffer.from(JSON.stringify(event));
  }

  async invoke(req: IncomingMessage, res: ServerResponse, url: URL, target: FunctionUrlTarget, rawPath: string, requestId: string, principal?: import("./auth/sigv4.js").PrincipalContext): Promise<void> {
    let status = 500;
    try {
      const payload = await this.event(req, url, target, rawPath, requestId, principal); await this.hooks.publishMetric(target.functionName, "UrlRequestCount");
      if (target.config.invokeMode === "BUFFERED") {
        const result = await this.hooks.invoke(target.functionName, payload, requestId, target.config.qualifier, principal?.lambdaLineage); if (result.functionError) throw new AwsError("Runtime.Unknown", "The Lambda function returned an unhandled error", 502); let output: any; try { output = JSON.parse(result.payload.toString("utf8")); } catch { throw new AwsError("Runtime.MalformedResponse", "The Lambda function returned an invalid response", 502); }
        let body: Buffer; let headers: Record<string, string>; let cookies: string[];
        if (output && typeof output === "object" && !Array.isArray(output) && output.statusCode !== undefined) { const metadata = validateStreamingResponseMetadata(output); status = metadata.statusCode; headers = metadata.headers; cookies = metadata.cookies; if (output.isBase64Encoded !== undefined && typeof output.isBase64Encoded !== "boolean") throw new AwsError("Runtime.MalformedResponse", "isBase64Encoded must be a boolean", 502); if (typeof output.body !== "string") throw new AwsError("Runtime.MalformedResponse", "A structured function URL response body must be a string", 502); body = output.isBase64Encoded ? Buffer.from(output.body, "base64") : Buffer.from(output.body); }
        else { status = 200; headers = { "content-type": "application/json" }; cookies = []; body = result.payload; }
        res.statusCode = status; setHeaders(res, headers, cookies); applyCors(req, res, target.config.cors); res.end(req.method === "HEAD" ? undefined : body);
      } else {
        let started = false; let metadata: { statusCode: number; headers: Record<string, string>; cookies: string[] } = { statusCode: 200, headers: { "content-type": "application/octet-stream" }, cookies: [] }; const start = (provided?: Record<string, unknown>) => { if (started) return; if (provided) metadata = validateStreamingResponseMetadata(provided); status = metadata.statusCode; res.statusCode = status; setHeaders(res, metadata.headers, metadata.cookies); applyCors(req, res, target.config.cors); res.flushHeaders(); started = true; };
        const result = await this.hooks.invokeStreaming(target.functionName, payload, requestId, target.config.qualifier, { onMetadata: value => { if (started) throw new AwsError("Runtime.MalformedResponse", "Response metadata arrived after streaming began", 502); start(value); }, onChunk: async chunk => { start(); if (req.method !== "HEAD") await writeWithBackpressure(res, chunk); } }, principal?.lambdaLineage);
        if (result.functionError) { if (started) { res.destroy(new Error("The Lambda response stream failed")); return; } throw new AwsError("Runtime.Unknown", "The Lambda response stream failed", 502); } start(); res.end();
      }
    } catch (error) {
      if (res.headersSent) { if (!res.writableEnded) res.destroy(error instanceof Error ? error : new Error(String(error))); return; }
      const aws = error instanceof AwsError ? error : new AwsError("ServiceException", error instanceof Error ? error.message : String(error), 500); status = aws.status; applyCors(req, res, target.config.cors); json(res, { message: status >= 500 ? "Internal Server Error" : aws.message }, status);
    } finally { if (status >= 400 && status < 500) await this.hooks.publishMetric(target.functionName, "Url4xxCount").catch(() => undefined); if (status >= 500) await this.hooks.publishMetric(target.functionName, "Url5xxCount").catch(() => undefined); }
  }
}
