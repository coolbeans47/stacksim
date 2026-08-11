const encoder = new TextEncoder();
const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
}

async function digest(value) {
  return hex(await crypto.subtle.digest("SHA-256", value));
}

async function hmac(key, value) {
  const cryptoKey = await crypto.subtle.importKey("raw", typeof key === "string" ? encoder.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value)));
}

async function bodyBytes(body) {
  if (body === undefined || body === null) return new Uint8Array();
  if (typeof body === "string") return encoder.encode(body);
  if (body instanceof URLSearchParams) return encoder.encode(body.toString());
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError("The console signer does not support this request body type.");
}

function canonicalPath(url, service) {
  if (service === "s3") return (url.pathname || "/").replace(/%[0-9a-f]{2}/gi, value => value.toUpperCase());
  const segments = [];
  for (const segment of url.pathname.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const normalized = `${url.pathname.startsWith("/") ? "/" : ""}${segments.join("/")}${segments.length && url.pathname.endsWith("/") ? "/" : ""}` || "/";
  return awsEncode(normalized).replace(/%2F/g, "/");
}

function canonicalQuery(url) {
  return [...url.searchParams.entries()]
    .map(([name, value]) => [awsEncode(name), awsEncode(value)])
    .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0)
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function timestamp(now) {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export async function signRequest(path, options, { credentials, region, service, now = new Date() }) {
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey) throw new Error("Console sign-in is required.");
  const url = new URL(path, location.origin);
  const method = String(options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers ?? {});
  const bytes = await bodyBytes(options.body);
  const payloadHash = bytes.byteLength ? await digest(bytes) : EMPTY_HASH;
  const amzDate = timestamp(now);
  const shortDate = amzDate.slice(0, 8);
  headers.set("x-amz-content-sha256", payloadHash);
  headers.set("x-amz-date", amzDate);
  if (credentials.sessionToken) headers.set("x-amz-security-token", credentials.sessionToken);

  const canonical = new Map([["host", url.host]]);
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (!new Set(["authorization", "content-length", "user-agent"]).has(lower)) canonical.set(lower, value.trim().replace(/\s+/g, " "));
  });
  const signedHeaders = [...canonical.keys()].sort();
  const canonicalHeaders = signedHeaders.map(name => `${name}:${canonical.get(name)}\n`).join("");
  const canonicalRequest = `${method}\n${canonicalPath(url, service)}\n${canonicalQuery(url)}\n${canonicalHeaders}\n${signedHeaders.join(";")}\n${payloadHash}`;
  const scope = `${shortDate}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await digest(encoder.encode(canonicalRequest))}`;
  const dateKey = await hmac(`AWS4${credentials.secretAccessKey}`, shortDate);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, service);
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));
  headers.set("authorization", `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`);
  return { url: `${url.pathname}${url.search}`, options: { ...options, method, headers } };
}
