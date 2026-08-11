import { AwsError } from "../errors.js";
import type { S3InternalObject, S3Service } from "../s3.js";

export const CLOUDFORMATION_TEMPLATE_URL_MAX_BYTES = 1_048_576;

export interface LocalS3ObjectLocation {
  bucket: string;
  key: string;
  versionId?: string;
  region?: string;
  style: "path" | "virtual";
  endpoint: "loopback" | "aws-s3";
}

function decodeComponent(value: string, label: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.includes("\0")) throw new Error();
    return decoded;
  } catch {
    throw new AwsError("ValidationError", `TemplateURL contains an invalid percent-encoded ${label}`, 400);
  }
}

function queryVersion(url: URL): string | undefined {
  if ([...url.searchParams.keys()].some(key => key !== "versionId") || url.searchParams.getAll("versionId").length > 1) {
    throw new AwsError("ValidationError", "TemplateURL may contain only one optional versionId query parameter", 400);
  }
  const raw = url.searchParams.get("versionId");
  return raw === null ? undefined : decodeComponent(raw, "versionId");
}

function pathParts(pathname: string): string[] {
  return pathname.replace(/^\/+/, "").split("/");
}

/** Parse a bounded set of S3 URL shapes without performing network I/O. */
export function parseLocalS3ObjectUrl(value: unknown, expectedRegion: string): LocalS3ObjectLocation {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) throw new AwsError("ValidationError", "TemplateURL must be a URL no longer than 2048 characters", 400);
  let url: URL;
  try { url = new URL(value); } catch { throw new AwsError("ValidationError", "TemplateURL is not a valid URL", 400); }
  if (url.username || url.password) throw new AwsError("ValidationError", "TemplateURL must not contain credentials", 400);
  if (url.hash) throw new AwsError("ValidationError", "TemplateURL must not contain a fragment", 400);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost") || hostname.endsWith(".127.0.0.1");
  if (loopback && !new Set(["http:", "https:"]).has(url.protocol)) throw new AwsError("ValidationError", "Local TemplateURL must use HTTP or HTTPS", 400);
  if (!loopback && url.protocol !== "https:") throw new AwsError("ValidationError", "AWS-shaped TemplateURL must use HTTPS", 400);

  let bucket: string | undefined;
  let keyParts: string[] = [];
  let region: string | undefined;
  let style: LocalS3ObjectLocation["style"] = "path";
  let endpoint: LocalS3ObjectLocation["endpoint"] = loopback ? "loopback" : "aws-s3";

  if (loopback) {
    const virtual = hostname.match(/^(.+)\.(?:localhost|127\.0\.0\.1)$/);
    const parts = pathParts(url.pathname);
    if (virtual) { bucket = virtual[1]; keyParts = parts; style = "virtual"; }
    else { bucket = parts.shift(); keyParts = parts; }
  } else {
    const virtual = hostname.match(/^([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\.s3(?:[.-]([a-z0-9-]+))?\.amazonaws\.com$/);
    const path = hostname.match(/^s3(?:[.-]([a-z0-9-]+))?\.amazonaws\.com$/);
    const parts = pathParts(url.pathname);
    if (virtual) { bucket = virtual[1]; region = virtual[2]; keyParts = parts; style = "virtual"; }
    else if (path) { region = path[1]; bucket = parts.shift(); keyParts = parts; }
    else throw new AwsError("ValidationError", "TemplateURL host is not an accepted local or AWS S3 endpoint", 400);
  }

  if (region && region !== expectedRegion) throw new AwsError("ValidationError", `TemplateURL Region ${region} does not match stack Region ${expectedRegion}`, 400);
  const decodedBucket = decodeComponent(bucket ?? "", "bucket");
  const rawKey = keyParts.join("/");
  const key = decodeComponent(rawKey, "object key");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(decodedBucket)) throw new AwsError("ValidationError", "TemplateURL contains an invalid S3 bucket name", 400);
  return { bucket: decodedBucket, key, versionId: queryVersion(url), region, style, endpoint };
}

export async function readLocalS3Template(s3: S3Service, templateUrl: unknown, expectedRegion: string): Promise<{ body: string; object: S3InternalObject; location: LocalS3ObjectLocation }> {
  const location = parseLocalS3ObjectUrl(templateUrl, expectedRegion);
  let object: S3InternalObject;
  try { object = await s3.readObjectBytes(location.bucket, location.key, location.versionId, CLOUDFORMATION_TEMPLATE_URL_MAX_BYTES); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AwsError("ValidationError", `Unable to read TemplateURL from local S3: ${message}`, 400);
  }
  return { body: object.body.toString("utf8"), object, location };
}
