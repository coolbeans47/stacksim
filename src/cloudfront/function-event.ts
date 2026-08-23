const MAX_URI_BYTES = 8 * 1024;
const MAX_HEADERS = 100;

export interface CloudFrontFunctionHeader { value: string; multiValue?: readonly { value: string }[] }
export interface CloudFrontFunctionRequest {
  method: string;
  uri: string;
  querystring: Record<string, { value: string; multiValue?: readonly { value: string }[] }>;
  headers: Record<string, CloudFrontFunctionHeader>;
  cookies: Record<string, { value: string; attributes?: string; multiValue?: readonly { value: string; attributes?: string }[] }>;
}

export interface CloudFrontFunctionEvent {
  version: "1.0";
  context: { distributionDomainName: string; distributionId: string; eventType: "viewer-request"; requestId: string };
  viewer: { ip: string };
  request: CloudFrontFunctionRequest;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateHeaderMap(value: unknown): asserts value is Record<string, CloudFrontFunctionHeader> {
  if (!plainRecord(value) || Object.keys(value).length > MAX_HEADERS) throw new TypeError("Function headers must be a bounded object");
  for (const [name, header] of Object.entries(value)) {
    if (name !== name.toLowerCase() || !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || !plainRecord(header) || typeof header.value !== "string" || /[\r\n\0]/.test(header.value)) throw new TypeError(`Invalid CloudFront Function header ${name}`);
    if (Buffer.byteLength(header.value) > 8 * 1024) throw new TypeError(`CloudFront Function header ${name} is too large`);
  }
}

export function validateFunctionRequest(value: unknown, originalMethod?: string): CloudFrontFunctionRequest {
  if (!plainRecord(value)) throw new TypeError("CloudFront Function must return a request object");
  const allowed = new Set(["method", "uri", "querystring", "headers", "cookies"]);
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown) throw new TypeError(`CloudFront Function request contains unsupported field ${unknown}`);
  if (typeof value.method !== "string" || !/^[A-Z]+$/.test(value.method) || originalMethod && value.method !== originalMethod) throw new TypeError("CloudFront Function cannot change the request method");
  if (typeof value.uri !== "string" || !value.uri.startsWith("/") || Buffer.byteLength(value.uri) > MAX_URI_BYTES || /[\0-\x1f\x7f\\]/.test(value.uri)) throw new TypeError("CloudFront Function returned an invalid URI");
  validateHeaderMap(value.headers ?? {});
  if (!plainRecord(value.querystring ?? {}) || !plainRecord(value.cookies ?? {})) throw new TypeError("CloudFront Function querystring and cookies must be objects");
  return structuredClone(value) as unknown as CloudFrontFunctionRequest;
}

export function cloneFunctionEvent(event: CloudFrontFunctionEvent): CloudFrontFunctionEvent {
  const encoded = JSON.stringify(event);
  if (Buffer.byteLength(encoded) > 40 * 1024) throw new TypeError("CloudFront Function event exceeds 40 KiB");
  return JSON.parse(encoded) as CloudFrontFunctionEvent;
}
