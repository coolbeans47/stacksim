import type { IncomingMessage, ServerResponse } from "node:http";

const FORM_LIMIT = 64 * 1024;

export class OAuthEndpointError extends Error {
  constructor(
    readonly error: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "OAuthEndpointError";
  }
}

function loopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") return true;
  const match = hostname.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return Boolean(match && match.slice(1).every(part => Number(part) <= 255));
}

export function validateCognitoPublicUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Cognito public URL must be an absolute HTTP(S) loopback origin.");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || !loopbackHostname(parsed.hostname)
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("Cognito public URL must be an HTTP(S) loopback origin with no credentials, path, query, or fragment.");
  }
  return parsed.origin;
}

export function cognitoDomainBase(publicOrigin: string, domain: string): string {
  return `${publicOrigin}/_stacksim/cognito-domain/${encodeURIComponent(domain)}`;
}

export async function readOAuthForm(
  req: IncomingMessage,
  maximumBytes = FORM_LIMIT,
): Promise<Record<string, string>> {
  const contentType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new OAuthEndpointError("invalid_request", "The request must use application/x-www-form-urlencoded.", 415);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximumBytes) throw new OAuthEndpointError("invalid_request", "The form body is too large.", 413);
    chunks.push(bytes);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const parameters = new URLSearchParams(text);
  const result: Record<string, string> = {};
  for (const key of new Set(parameters.keys())) {
    const values = parameters.getAll(key);
    if (values.length !== 1) {
      throw new OAuthEndpointError("invalid_request", `Duplicate form parameter: ${key}.`);
    }
    result[key] = values[0];
  }
  return result;
}

export function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = String(req.headers.cookie ?? "");
  for (const component of header.split(";")) {
    const index = component.indexOf("=");
    if (index < 1) continue;
    if (component.slice(0, index).trim() !== name) continue;
    const value = component.slice(index + 1).trim();
    if (/^[A-Za-z0-9_-]{20,256}$/.test(value)) return value;
  }
  return undefined;
}

export function sessionCookie(
  name: string,
  value: string,
  secure: boolean,
  maximumAgeSeconds: number,
): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maximumAgeSeconds}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(name: string, secure: boolean): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function oauthHeaders(res: ServerResponse): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("pragma", "no-cache");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
}

export function sendOAuthJson(
  res: ServerResponse,
  value: Record<string, unknown>,
  status = 200,
): void {
  oauthHeaders(res);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}

export function sendOAuthError(res: ServerResponse, error: OAuthEndpointError): void {
  if (error.status === 401) res.setHeader("www-authenticate", 'Basic realm="Cognito token endpoint"');
  sendOAuthJson(res, { error: error.error, error_description: error.message }, error.status);
}

export function sendOAuthRedirect(res: ServerResponse, target: string): void {
  oauthHeaders(res);
  res.statusCode = 302;
  res.setHeader("location", target);
  res.end();
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function sendManagedLoginHtml(res: ServerResponse, body: string, status = 200): void {
  oauthHeaders(res);
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  res.end(body);
}
