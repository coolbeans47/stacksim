import { createHash, createHmac } from "node:crypto";

export interface TestCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalPath(url: URL, service: string): string {
  if (service === "s3") return url.pathname.replace(/%[0-9a-f]{2}/gi, value => value.toUpperCase()) || "/";
  const segments: string[] = [];
  for (const segment of url.pathname.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const normalized = `${url.pathname.startsWith("/") ? "/" : ""}${segments.join("/")}${segments.length && url.pathname.endsWith("/") ? "/" : ""}` || "/";
  return encode(normalized).replace(/%2F/g, "/");
}

export async function signedFetch(
  urlValue: string,
  options: Omit<RequestInit, "credentials"> & { service: string; region: string; credentials: TestCredentials },
): Promise<Response> {
  const { service, region, credentials, ...request } = options;
  const url = new URL(urlValue);
  const method = String(request.method ?? "GET").toUpperCase();
  const body = request.body === undefined || request.body === null
    ? Buffer.alloc(0)
    : typeof request.body === "string" ? Buffer.from(request.body) : Buffer.from(request.body as any);
  const payloadHash = createHash("sha256").update(body).digest("hex");
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const shortDate = amzDate.slice(0, 8);
  const headers = new Headers(request.headers);
  headers.set("x-amz-content-sha256", payloadHash);
  headers.set("x-amz-date", amzDate);
  if (credentials.sessionToken) headers.set("x-amz-security-token", credentials.sessionToken);
  const canonical = new Map<string, string>([["host", url.host]]);
  headers.forEach((value, name) => canonical.set(name.toLowerCase(), value.trim().replace(/\s+/g, " ")));
  const names = [...canonical.keys()].sort();
  const canonicalHeaders = names.map(name => `${name}:${canonical.get(name)}\n`).join("");
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([name, value]) => [encode(name), encode(value)] as const)
    .sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonicalRequest = `${method}\n${canonicalPath(url, service)}\n${canonicalQuery}\n${canonicalHeaders}\n${names.join(";")}\n${payloadHash}`;
  const scope = `${shortDate}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, shortDate), region), service), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  headers.set("authorization", `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`);
  return fetch(url, { ...request, method, headers, body: body.length ? body : undefined });
}
