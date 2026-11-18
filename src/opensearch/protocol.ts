import type { IncomingMessage, ServerResponse } from "node:http";
import models from "../../docs/opensearch/models.json" with { type: "json" };
import { AwsError, sendAwsError } from "../errors.js";
import { readBody } from "../util.js";

export type Family = "opensearch" | "opensearchserverless" | "osis" | "es";
const contracts = models as Record<string, any>;
export const OPENSEARCH_BODY_LIMIT = 10 * 1024 * 1024;

export function familyForRequest(req: IncomingMessage, url: URL): Family | undefined {
  if (url.pathname.startsWith("/_stacksim/api/opensearch/ingestion/")) return "osis";
  if (url.pathname.startsWith("/_stacksim/api/opensearch/serverless/")) return "opensearchserverless";
  if (url.pathname.startsWith("/2021-01-01/")) return "opensearch";
  if (url.pathname.startsWith("/2015-01-01/")) return "es";
  if (url.pathname.startsWith("/2022-01-01/osis/")) return "osis";
  if (String(req.headers["x-amz-target"] ?? "").startsWith("OpenSearchServerless.")) return "opensearchserverless";
  return undefined;
}

export interface OperationRoute { family: Family; operation: string; input: Record<string, any>; status: number }
export function resolveOperation(req: IncomingMessage, url: URL, body: Record<string, any> = {}): OperationRoute | undefined {
  const family = familyForRequest(req, url);
  if (!family) return undefined;
  const model = contracts[family];
  const operations = Object.entries<any>(model.operations).sort((a, b) => b[1].http.requestUri.length - a[1].http.requestUri.length);
  for (const [operation, spec] of operations) {
    const names: string[] = [];
    if (family === "opensearchserverless") {
      if (req.method !== "POST" || req.headers["x-amz-target"] !== `OpenSearchServerless.${operation}`) continue;
    } else {
      const pattern = spec.http.requestUri.replace(/\{([^}]+)\}/g, (_: string, name: string) => { names.push(name); return "([^/]+)"; });
      const match = new RegExp(`^${pattern.replace(/\/$/, "")}/?$`).exec(url.pathname);
      if (req.method !== spec.http.method || !match) continue;
      body = { ...body };
      names.forEach((uriName, i) => {
        const members = model.shapes[spec.input?.shape]?.members ?? {};
        const name = Object.entries<any>(members).find(([memberName, member]) => member.location === "uri" && (member.locationName ?? memberName) === uriName)?.[0] ?? uriName;
        try {
          const decoded = decodeURIComponent(match[i + 1]);
          if (body[name] !== undefined && body[name] !== decoded) throw new AwsError("ValidationException", `Body ${name} contradicts the request URI`);
          body[name] = decoded;
        }
        catch (error) { if (error instanceof AwsError) throw error; throw new AwsError("ValidationException", "Invalid URI encoding"); }
      });
    }
    const members = model.shapes[spec.input?.shape]?.members ?? {};
    const input = { ...body };
    const queryMembers = new Set(Object.entries<any>(members).filter(([, member]) => member.location === "querystring").map(([name, member]) => member.locationName ?? name));
    for (const key of url.searchParams.keys()) if (!queryMembers.has(key) && !key.startsWith("X-Amz-")) throw new AwsError("ValidationException", `Unknown query parameter ${key}`);
    for (const [name, member] of Object.entries<any>(members)) {
      if (member.location !== "querystring") continue;
      const key = member.locationName ?? name;
      if (!url.searchParams.has(key)) continue;
      const type = model.shapes[member.shape]?.type;
      const raw = url.searchParams.get(key)!;
      if (type !== "list" && url.searchParams.getAll(key).length !== 1) throw new AwsError("ValidationException", `Repeated query parameter ${key}`);
      if (type === "boolean" && !["true", "false"].includes(raw)) throw new AwsError("ValidationException", `Query parameter ${key} must be true or false`);
      input[name] = type === "list" ? url.searchParams.getAll(key) : type === "integer" || type === "long" ? Number(raw) : type === "boolean" ? raw === "true" : raw;
    }
    return { family, operation, input, status: spec.http.responseCode ?? 200 };
  }
  return undefined;
}

export function validateInput(route: OperationRoute): void {
  const model = contracts[route.family];
  const shape = model.operations[route.operation].input?.shape;
  if (shape) validateShape(model, shape, route.input, "request");
}

function validateShape(model: any, shapeName: string, value: any, path: string, depth = 0): void {
  if (depth > 32) throw new AwsError("ValidationException", "Request nesting exceeds the local limit");
  const shape = model.shapes[shapeName];
  if (shape.document) return;
  const invalid = (reason: string): never => { throw new AwsError("ValidationException", `${path}: ${reason}`); };
  if (value === null || value === undefined) invalid("must not be null");
  if (shape.type === "structure") {
    if (typeof value !== "object" || Array.isArray(value)) invalid("must be an object");
    for (const key of shape.required ?? []) if (value[key] === undefined) invalid(`${key} is required`);
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(shape.members, key)) invalid(`unknown member ${key}`);
      validateShape(model, shape.members[key].shape, child, `${path}.${key}`, depth + 1);
    }
  } else if (shape.type === "list") {
    if (!Array.isArray(value)) invalid("must be an array");
    value.forEach((child: any, i: number) => validateShape(model, shape.member.shape, child, `${path}[${i}]`, depth + 1));
  } else if (shape.type === "map") {
    if (typeof value !== "object" || Array.isArray(value)) invalid("must be an object");
    for (const [key, child] of Object.entries(value)) {
      validateShape(model, shape.key.shape, key, `${path} key`, depth + 1);
      validateShape(model, shape.value.shape, child, `${path}.${key}`, depth + 1);
    }
  } else if (shape.type === "string") {
    if (typeof value !== "string") invalid("must be a string");
    if (shape.enum && !shape.enum.includes(value)) invalid(`must be one of ${shape.enum.join(", ")}`);
    // AWS models use the Java/POSIX XDigit class, which JavaScript regexes do
    // not recognize. Preserve the modeled GUID constraint when translating it.
    if (shape.pattern && !new RegExp(`^(?:${shape.pattern.replaceAll("\\p{XDigit}", "[0-9a-fA-F]")})$`).test(value)) invalid("invalid format");
  } else if (shape.type === "boolean") {
    if (typeof value !== "boolean") invalid("must be a boolean");
  } else if (["integer", "long", "double", "float", "timestamp"].includes(shape.type)) {
    if (typeof value !== "number" || !Number.isFinite(value)) invalid("must be a finite number");
    if (["integer", "long"].includes(shape.type) && !Number.isSafeInteger(value)) invalid("must be an integer");
  }
  const size = typeof value === "number" ? value : typeof value === "string" || Array.isArray(value) ? value.length : undefined;
  if (size !== undefined && ((shape.min !== undefined && size < shape.min) || (shape.max !== undefined && size > shape.max))) invalid(`outside allowed range ${shape.min ?? 0}–${shape.max ?? "unbounded"}`);
}

/** Read before SigV4, retaining the exact signed bytes and enforcing a bound. */
export async function readOpenSearchBody(req: IncomingMessage): Promise<Buffer> {
  const cached = (req as any)[Symbol.for("stacksim.request-body")];
  if (cached) {
    if (cached.length > OPENSEARCH_BODY_LIMIT) throw new AwsError("ValidationException", "Request exceeds the 10 MiB local limit", 413);
    return cached;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += Buffer.byteLength(chunk);
    if (size > OPENSEARCH_BODY_LIMIT) { req.resume(); throw new AwsError("ValidationException", "Request exceeds the 10 MiB local limit", 413); }
    chunks.push(Buffer.from(chunk));
  }
  (req as any)[Symbol.for("stacksim.request-body")] = Buffer.concat(chunks);
  return readBody(req);
}

export function sendOpenSearchError(res: ServerResponse, error: unknown, family: Family = "opensearch"): void {
  const aws = error instanceof AwsError ? error : new AwsError(family === "opensearchserverless" ? "InternalServerException" : "InternalException", "The local OpenSearch operation failed", 500);
  sendAwsError(res, aws, family === "opensearchserverless" ? "json" : "rest", "");
}
