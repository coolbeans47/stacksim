import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AwsError } from "../errors.js";
import type { Clock } from "../core/clock.js";
import type { StateStore } from "../state.js";
import { readBody } from "../util.js";

export interface PrincipalContext {
  principalType?: "root" | "user" | "roleSession" | "service" | "anonymous";
  accessKeyId: string;
  principalArn: string;
  principalId: string;
  accountId: string;
  roleArn?: string;
  sessionArn?: string;
  userName?: string;
  userId?: string;
  principalTags?: Record<string, string>;
  /** Legacy construction compatibility; authenticated principals returned to handlers omit it. */
  sessionToken?: string;
  sourceIdentity?: string;
  sessionTags?: Record<string, string>;
  lambdaLineage?: string[];
}

interface ParsedSignature { accessKeyId: string; date: string; region: string; service: string; signedHeaders: string[]; signature: string; amzDate: string; presigned: boolean }
const REQUEST_BODY = Symbol.for("stacksim.request-body");
const REQUEST_BODY_FILE = Symbol.for("stacksim.request-body-file");
const STREAMING_SIGNATURE = Symbol.for("stacksim.sigv4-stream");

function encode(value: string): string { return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`); }
function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function hmac(key: string | Buffer, value: string): Buffer { return createHmac("sha256", key).update(value).digest(); }

async function spoolS3Request(req: IncomingMessage, store: StateStore): Promise<{ file: string; digest: string }> {
  const directory = resolve(store.root, "s3", "staging"); await mkdir(directory, { recursive: true }); const file = resolve(directory, `${randomUUID()}.signed`); const digest = createHash("sha256"); const cached = (req as any)[REQUEST_BODY] as Buffer | undefined; const source = cached ? Readable.from([cached]) : req; const hashing = new Transform({ transform(chunk, _encoding, callback) { digest.update(chunk); callback(null, chunk); } });
  try { await pipeline(source, hashing, createWriteStream(file, { mode: 0o600, flags: "wx" })); (req as any)[REQUEST_BODY_FILE] = { file }; return { file, digest: digest.digest("hex") }; }
  catch (error) { try { await unlink(file); } catch {} throw error; }
}

function parse(req: IncomingMessage, url: URL): ParsedSignature {
  const authorization = String(req.headers.authorization ?? "");
  if (authorization) {
    const match = authorization.match(/^AWS4-HMAC-SHA256\s+Credential=([^/\s]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request,\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]{64})$/i);
    if (!match) throw new AwsError("IncompleteSignature", "Authorization header requires Credential, SignedHeaders, and Signature", 400);
    return { accessKeyId: match[1], date: match[2], region: match[3], service: match[4], signedHeaders: match[5].toLowerCase().split(";"), signature: match[6].toLowerCase(), amzDate: String(req.headers["x-amz-date"] ?? req.headers.date ?? ""), presigned: false };
  }
  const algorithm = url.searchParams.get("X-Amz-Algorithm"); if (algorithm !== "AWS4-HMAC-SHA256") throw new AwsError("MissingAuthenticationToken", "Request is missing Authentication Token", 403);
  const credential = url.searchParams.get("X-Amz-Credential")?.split("/"); if (!credential || credential.length !== 5) throw new AwsError("IncompleteSignature", "Invalid X-Amz-Credential", 400);
  const signature = url.searchParams.get("X-Amz-Signature"); const signed = url.searchParams.get("X-Amz-SignedHeaders"); if (!signature || !signed) throw new AwsError("IncompleteSignature", "Missing presigned signature fields", 400);
  return { accessKeyId: credential[0], date: credential[1], region: credential[2], service: credential[3], signedHeaders: signed.toLowerCase().split(";"), signature: signature.toLowerCase(), amzDate: url.searchParams.get("X-Amz-Date") ?? "", presigned: true };
}

function timestamp(value: string): number {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/); if (!match) return NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
}

function secretFor(store: StateStore, accessKeyId: string, clock: Clock): { secret: string; principal: PrincipalContext; token?: string } {
  const configured = store.configuredCredentials;
  if (configured?.rootRecovery && accessKeyId === configured.accessKeyId) return { secret: configured.secretAccessKey, principal: { principalType: "root", accessKeyId, principalArn: `arn:aws:iam::${store.accountId}:root`, principalId: store.accountId, accountId: store.accountId } };
    const userMatches = Object.entries(store.state.accounts).flatMap(([accountId, account]) => {
      const key = account.iam.accessKeys[accessKeyId];
      const user = key && account.iam.users[key.userName];
      return key?.status === "Active" && user ? [{ accountId, key, user }] : [];
    });
    if (userMatches.length === 1) {
      const { accountId, key, user } = userMatches[0];
    const material = store.credentialStore?.get(key.credentialId, { type: "iam-user", accountId, ownerId: user.userId, accessKeyId });
    if (!material) throw new AwsError("InvalidClientTokenId", "The security token included in the request is invalid", 403);
    return { secret: material.secretAccessKey, principal: { principalType: "user", accessKeyId, principalArn: user.arn, principalId: user.userId, accountId, userName: user.userName, userId: user.userId, principalTags: { ...user.tags } } };
  }
  const matches = Object.entries(store.state.accounts).flatMap(([accountId, account]) => {
    const session = account.iam.sessions[accessKeyId];
    return session && session.expiration > clock.now() ? [{ accountId, session }] : [];
  });
  if (matches.length !== 1) throw new AwsError("InvalidClientTokenId", "The security token included in the request is invalid", 403);
  const { accountId, session } = matches[0];
  const material = session.credentialId ? store.credentialStore?.get(session.credentialId, { type: "sts-session", accountId, ownerId: session.principalId, accessKeyId }) : undefined;
  if (!material?.sessionToken) throw new AwsError("InvalidClientTokenId", "The security token included in the request is invalid", 403);
  return { secret: material.secretAccessKey, token: material.sessionToken, principal: { principalType: "roleSession", accessKeyId, principalArn: session.principalArn, principalId: session.principalId, accountId, roleArn: session.roleArn, sessionArn: session.principalArn, sourceIdentity: session.sourceIdentity, sessionTags: session.sessionTags, lambdaLineage: session.lambdaLineage } };
}

export async function authenticateSigV4(req: IncomingMessage, url: URL, store: StateStore, clock: Clock, expectedRegion?: string, expectedService?: string): Promise<PrincipalContext> {
  const signature = parse(req, url); const credential = secretFor(store, signature.accessKeyId, clock);
  if (expectedRegion && signature.region !== expectedRegion) throw new AwsError("SignatureDoesNotMatch", `Credential should be scoped to region ${expectedRegion}`, 403);
  if (expectedService && signature.service !== expectedService) throw new AwsError("SignatureDoesNotMatch", `Credential should be scoped to service ${expectedService}`, 403);
  const requestTime = timestamp(signature.amzDate); if (!Number.isFinite(requestTime)) throw new AwsError("IncompleteSignature", "A valid X-Amz-Date header is required", 400);
  const now = clock.now();
  if (signature.presigned) {
    const expiresSeconds = Number(url.searchParams.get("X-Amz-Expires"));
    if (!Number.isInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 604_800) throw new AwsError("AuthorizationQueryParametersError", "X-Amz-Expires must be between 1 and 604800 seconds", 400);
    if (requestTime > now + 5 * 60_000 || now > requestTime + expiresSeconds * 1000) throw new AwsError("RequestExpired", "Request has expired", 400);
  } else if (Math.abs(now - requestTime) > 5 * 60_000) throw new AwsError("RequestExpired", "Request has expired", 400);
  const suppliedToken = signature.presigned ? url.searchParams.get("X-Amz-Security-Token") : req.headers["x-amz-security-token"];
  if (credential.token && suppliedToken !== credential.token) throw new AwsError("InvalidClientTokenId", "The security token included in the request is invalid", 403);
  if (!credential.token && suppliedToken) throw new AwsError("InvalidClientTokenId", "The security token included in the request is invalid", 403);
  const normalizedSegments: string[] = []; for (const segment of url.pathname.split("/")) { if (!segment || segment === ".") continue; if (segment === "..") normalizedSegments.pop(); else normalizedSegments.push(segment); } const normalizedPath = `${url.pathname.startsWith("/") ? "/" : ""}${normalizedSegments.join("/")}${normalizedSegments.length && url.pathname.endsWith("/") ? "/" : ""}`;
  const rawRequestPath = String(req.url ?? "/").split("?", 1)[0] || "/"; const canonicalUri = signature.service === "s3" ? rawRequestPath.replace(/%[0-9a-f]{2}/gi, value => value.toUpperCase()) : encode(normalizedPath || "/").replace(/%2F/g, "/");
  const compareBytes = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0; const query = [...url.searchParams.entries()].filter(([key]) => key.toLowerCase() !== "x-amz-signature").map(([key, value]) => [encode(key), encode(value)] as const).sort((a, b) => compareBytes(a[0], b[0]) || compareBytes(a[1], b[1])).map(([key, value]) => `${key}=${value}`).join("&");
  const canonicalHeaders = signature.signedHeaders.map(name => { const value = name === "host" ? req.headers.host : req.headers[name]; if (value === undefined) throw new AwsError("IncompleteSignature", `Signed header ${name} is missing`, 400); return `${name}:${(Array.isArray(value) ? value.join(",") : String(value)).trim().replace(/\s+/g, " ")}\n`; }).join("");
  const declaredPayloadHash = req.headers["x-amz-content-sha256"] ?? url.searchParams.get("X-Amz-Content-Sha256"); const streamingPayload = new Set(["STREAMING-AWS4-HMAC-SHA256-PAYLOAD", "STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER", "STREAMING-UNSIGNED-PAYLOAD-TRAILER"]); let payloadHash: string; let spooledFile: string | undefined;
  if (signature.service === "s3" && (declaredPayloadHash === "UNSIGNED-PAYLOAD" || streamingPayload.has(String(declaredPayloadHash)))) payloadHash = String(declaredPayloadHash);
  else if (signature.service === "s3") { const spooled = await spoolS3Request(req, store); spooledFile = spooled.file; payloadHash = String(declaredPayloadHash ?? spooled.digest); if (payloadHash !== spooled.digest) { try { await unlink(spooled.file); } catch {} delete (req as any)[REQUEST_BODY_FILE]; throw new AwsError("SignatureDoesNotMatch", "The request payload hash does not match", 403); } }
  else { const body = await readBody(req); payloadHash = String(declaredPayloadHash ?? hash(body)); if (payloadHash !== "UNSIGNED-PAYLOAD" && !streamingPayload.has(payloadHash) && payloadHash !== hash(body)) throw new AwsError("SignatureDoesNotMatch", "The request payload hash does not match", 403); }
  const canonicalRequest = `${req.method}\n${canonicalUri}\n${query}\n${canonicalHeaders}\n${signature.signedHeaders.join(";")}\n${payloadHash}`; const scope = `${signature.date}/${signature.region}/${signature.service}/aws4_request`; const stringToSign = `AWS4-HMAC-SHA256\n${signature.amzDate}\n${scope}\n${hash(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credential.secret}`, signature.date), signature.region), signature.service), "aws4_request"); const expected = createHmac("sha256", signingKey).update(stringToSign).digest(); const actual = Buffer.from(signature.signature, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { if (spooledFile) { try { await unlink(spooledFile); } catch {} delete (req as any)[REQUEST_BODY_FILE]; } throw new AwsError("SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided", 403); }
  if (payloadHash.startsWith("STREAMING-AWS4-HMAC-SHA256-PAYLOAD")) (req as any)[STREAMING_SIGNATURE] = { amzDate: signature.amzDate, scope, previous: signature.signature, signingKey: signingKey.toString("base64"), trailer: payloadHash === "STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER" };
  if (credential.principal.principalType === "user") {
    const key = store.state.accounts[credential.principal.accountId]?.iam.accessKeys[credential.principal.accessKeyId];
    if (key) {
      key.lastUsed = { date: now, serviceName: signature.service, region: signature.region };
      void store.save();
    }
  }
  return credential.principal;
}

export function principalWithoutValidation(req: IncomingMessage, url: URL, store: StateStore, clock: Clock): PrincipalContext {
  const accessKeyId = String(req.headers.authorization ?? "").match(/Credential=([^/\s]+)/)?.[1] ?? url.searchParams.get("X-Amz-Credential")?.split("/")[0] ?? "";
  try { return secretFor(store, accessKeyId, clock).principal; } catch { return { principalType: "anonymous", accessKeyId: "", principalArn: "*", principalId: "anonymous", accountId: store.accountId }; }
}
