import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AwsError } from "../../errors.js";
import { setCloudFormationIdempotencyKey, setCloudFormationOwner } from "../../core/internal-request.js";

export interface InMemoryServiceResponse<T = unknown> {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | number | readonly string[]>>;
  readonly body: T;
  readonly rawBody: Buffer;
}

/**
 * Invoke one of the simulator's HTTP-shaped service handlers without opening a
 * loopback socket. Providers therefore use the exact same validation and state
 * mutations as SDK requests while retaining the CloudFormation role session.
 */
export async function invokeJsonService<T>(options: {
  method: string;
  path: string;
  input?: unknown;
  /** Internal marker; never serialized as an HTTP header. */
  cloudFormationIdempotencyKey?: string;
  /** Stable stack/logical-resource owner; never serialized as an HTTP header. */
  cloudFormationOwner?: string;
  handle: (req: IncomingMessage, res: ServerResponse, pathname: string, url: URL) => Promise<unknown>;
}): Promise<InMemoryServiceResponse<T>> {
  const encoded = options.input === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(options.input));
  const request = Readable.from(encoded.length ? [encoded] : []) as unknown as IncomingMessage;
  request.method = options.method;
  request.url = options.path;
  request.headers = encoded.length ? { "content-type": "application/json", "content-length": String(encoded.length) } : {};
  setCloudFormationIdempotencyKey(request, options.cloudFormationIdempotencyKey);
  setCloudFormationOwner(request, options.cloudFormationOwner);

  let statusCode = 200;
  const headers: Record<string, string | number | readonly string[]> = {};
  const chunks: Buffer[] = [];
  const response = {
    get statusCode() { return statusCode; },
    set statusCode(value: number) { statusCode = value; },
    setHeader(name: string, value: string | number | readonly string[]) { headers[name.toLowerCase()] = value; return this; },
    getHeader(name: string) { return headers[name.toLowerCase()]; },
    hasHeader(name: string) { return Object.hasOwn(headers, name.toLowerCase()); },
    removeHeader(name: string) { delete headers[name.toLowerCase()]; },
    write(chunk: unknown) { if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; },
    end(chunk?: unknown) { if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return this; },
    flushHeaders() {},
  } as unknown as ServerResponse;

  const url = new URL(options.path, "http://stacksim.local");
  await options.handle(request, response, url.pathname, url);
  const rawBody = Buffer.concat(chunks);
  let body: unknown = undefined;
  if (rawBody.length) {
    try { body = JSON.parse(rawBody.toString("utf8")); }
    catch { body = rawBody; }
  }
  if (statusCode >= 400) {
    const document = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const rawType = String(document.__type ?? document.code ?? `HTTP${statusCode}`);
    const code = rawType.includes("#") ? rawType.slice(rawType.lastIndexOf("#") + 1) : rawType;
    throw new AwsError(code, String(document.message ?? document.Message ?? `Service request failed with HTTP ${statusCode}`), statusCode, document);
  }
  return { statusCode, headers, body: body as T, rawBody };
}
