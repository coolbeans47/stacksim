import { createHash, randomBytes } from "node:crypto";
import type { CloudFrontResourceOwnerState } from "../types.js";

export const CLOUDFRONT_API_VERSION = "2020-05-31";
export const CLOUDFRONT_XML_NAMESPACE = "http://cloudfront.amazonaws.com/doc/2020-05-31/";
export const CACHING_DISABLED_ID = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
export const CACHING_OPTIMIZED_ID = "658327ea-f89d-4fab-a63d-7e88639e58f6";

export const MANAGED_CACHE_POLICIES = Object.freeze({
  [CACHING_DISABLED_ID]: Object.freeze({ Id: CACHING_DISABLED_ID, Type: "managed", CachePolicyConfig: Object.freeze({ Name: "Managed-CachingDisabled", Comment: "Policy with caching disabled", DefaultTTL: 0, MaxTTL: 0, MinTTL: 0, ParametersInCacheKeyAndForwardedToOrigin: Object.freeze({ EnableAcceptEncodingBrotli: false, EnableAcceptEncodingGzip: false, CookiesConfig: Object.freeze({ CookieBehavior: "none" }), HeadersConfig: Object.freeze({ HeaderBehavior: "none" }), QueryStringsConfig: Object.freeze({ QueryStringBehavior: "none" }) }) }) }),
  [CACHING_OPTIMIZED_ID]: Object.freeze({ Id: CACHING_OPTIMIZED_ID, Type: "managed", CachePolicyConfig: Object.freeze({ Name: "Managed-CachingOptimized", Comment: "Default policy for S3 origin", DefaultTTL: 86_400, MaxTTL: 31_536_000, MinTTL: 1, ParametersInCacheKeyAndForwardedToOrigin: Object.freeze({ EnableAcceptEncodingBrotli: true, EnableAcceptEncodingGzip: true, CookiesConfig: Object.freeze({ CookieBehavior: "none" }), HeadersConfig: Object.freeze({ HeaderBehavior: "none" }), QueryStringsConfig: Object.freeze({ QueryStringBehavior: "none" }) }) }) }),
});

export function cloudFrontArn(accountId: string, kind: "distribution" | "function" | "origin-access-control" | "response-headers-policy" | "cache-policy", id: string): string {
  return `arn:aws:cloudfront::${accountId}:${kind}/${id}`;
}

export function opaqueId(prefix: string, bytes = 9): string { return `${prefix}${randomBytes(bytes).toString("hex").toUpperCase()}`; }
export function domainName(): string { return `d${randomBytes(10).toString("hex")}.cloudfront.net`; }
export function etag(value: unknown, revision: number): string { return createHash("sha256").update(`${revision}\0${JSON.stringify(value)}`).digest("base64url").slice(0, 24); }
export function canonical<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

export function ownerFromContext(value?: { stackId: string; logicalId: string; resourceOperationId: string }): CloudFrontResourceOwnerState | undefined {
  return value ? { stackId: value.stackId, logicalId: value.logicalId, createOperationId: value.resourceOperationId } : undefined;
}

export function items(value: unknown, member: string): any[] {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
  const container = record.Items;
  if (Array.isArray(container)) return container as Record<string, any>[];
  if (container && typeof container === "object") {
    const nested = container[member];
    if (Array.isArray(nested)) return nested;
    if (nested !== undefined && nested !== null) return [nested];
  }
  const direct = record[member];
  if (Array.isArray(direct)) return direct;
  return direct !== undefined && direct !== null ? [direct] : [];
}

export function tags(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of items(value, "Tag")) if (typeof item.Key === "string" && typeof item.Value === "string") result[item.Key] = item.Value;
  return result;
}

export function tagItems(value: Record<string, string>): { Items?: { Tag: { Key: string; Value: string }[] } } {
  const list = Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([Key, Value]) => ({ Key, Value }));
  return list.length ? { Items: { Tag: list } } : {};
}

export function nameValid(name: string, maximum = 64): boolean { return name.length >= 1 && name.length <= maximum && /^[A-Za-z0-9_-]+$/.test(name); }
export function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
