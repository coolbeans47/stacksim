import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizationTarget } from "../src/auth/target.js";
import { CloudFrontCache, matchesInvalidation } from "../src/cloudfront/cache.js";
import type { CloudFrontFunctionEvent } from "../src/cloudfront/function-event.js";
import { CLOUDFRONT_FUNCTION_LIMITS, CloudFrontFunctionRunner } from "../src/cloudfront/function-runner.js";
import { CACHING_DISABLED_ID, CACHING_OPTIMIZED_ID, MANAGED_CACHE_POLICIES } from "../src/cloudfront/model.js";
import { applySecurityHeaders } from "../src/cloudfront/response-headers.js";

const accountId = "000000000000";
const region = "eu-west-1";
const principal = { principalArn: `arn:aws:iam::${accountId}:role/deployer`, accountId, accessKeyId: "admin" } as any;

function request(method: string, path: string, body = "", encrypted = true): any {
  return {
    method, url: path, headers: { "content-type": "application/xml" }, socket: { remoteAddress: "127.0.0.1", encrypted },
    [Symbol.for("stacksim.request-body")]: Buffer.from(body),
  };
}

function event(uri = "/deep/link"): CloudFrontFunctionEvent {
  return {
    version: "1.0", context: { distributionDomainName: "dabc.cloudfront.net", distributionId: "EDIST", eventType: "viewer-request", requestId: "request" }, viewer: { ip: "127.0.0.1" },
    request: { method: "GET", uri, querystring: {}, headers: { host: { value: "dabc.cloudfront.net" } }, cookies: {} },
  };
}

test("CloudFront IAM targets exact actions, global ARNs, request tags, and reject unknown routes", async () => {
  const now = Date.parse("2026-08-22T12:00:00.000Z");
  const cases: Array<[string, string, string, string]> = [
    ["GET", "/2020-05-31/distribution/EDIST", "cloudfront:GetDistribution", `arn:aws:cloudfront::${accountId}:distribution/EDIST`],
    ["PUT", "/2020-05-31/distribution/EDIST/config", "cloudfront:UpdateDistribution", `arn:aws:cloudfront::${accountId}:distribution/EDIST`],
    ["POST", "/2020-05-31/function/rewrite/publish", "cloudfront:PublishFunction", `arn:aws:cloudfront::${accountId}:function/rewrite`],
    ["GET", `/2020-05-31/cache-policy/${CACHING_OPTIMIZED_ID}/config`, "cloudfront:GetCachePolicyConfig", `arn:aws:cloudfront::aws:cache-policy/${CACHING_OPTIMIZED_ID}`],
    ["POST", "/2020-05-31/distribution/EDIST/invalidation", "cloudfront:CreateInvalidation", `arn:aws:cloudfront::${accountId}:distribution/EDIST`],
  ];
  for (const [method, path, action, resource] of cases) {
    const resolved = await authorizationTarget(request(method, path), new URL(`https://localhost${path}`), "cloudfront", region, accountId, principal, now);
    assert.equal(resolved.action, action); assert.equal(resolved.resource, resource); assert.equal(resolved.context["aws:RequestedRegion"], region); assert.equal(resolved.context["aws:SecureTransport"], true);
  }

  const tags = "<DistributionConfigWithTags><DistributionConfig/><Tags><Items><Tag><Key>Environment</Key><Value>dev&amp;test</Value></Tag></Items></Tags></DistributionConfigWithTags>";
  const create = await authorizationTarget(request("POST", "/2020-05-31/distribution", tags), new URL("https://localhost/2020-05-31/distribution"), "cloudfront", region, accountId, principal, now);
  assert.equal(create.action, "cloudfront:CreateDistribution"); assert.equal(create.resource, "*");
  assert.equal(create.context["aws:RequestTag/Environment"], "dev&test"); assert.deepEqual(create.context["aws:TagKeys"], ["Environment"]);
  assert.deepEqual(create.additionalTargets?.map(target => [target.action, target.resource, target.context["aws:RequestTag/Environment"]]), [["cloudfront:TagResource", "*", "dev&test"]]);

  await assert.rejects(
    authorizationTarget(request("PATCH", "/2020-05-31/distribution/EDIST"), new URL("https://localhost/2020-05-31/distribution/EDIST"), "cloudfront", region, accountId, principal, now),
    /Unsupported CloudFront method\/path/,
  );
});

test("CloudFront Function runtime is fresh, bounded, validates output, and cannot reach host surfaces", { timeout: 30_000 }, async () => {
  const runner = new CloudFrontFunctionRunner();
  const rewrite = await runner.invoke("function handler(event){event.request.uri='/index.html';return event.request;}", event());
  assert.equal(rewrite.uri, "/index.html");

  const isolatedCode = "var counter=0; function handler(event){counter++;event.request.uri='/' + counter;return event.request;}";
  assert.equal((await runner.invoke(isolatedCode, event())).uri, "/1"); assert.equal((await runner.invoke(isolatedCode, event())).uri, "/1");

  const escaped = await runner.invoke("function handler(event){var root=({}).constructor.constructor('return this')();event.request.headers.leak={value:typeof root.process+','+typeof root.require+','+typeof root.fetch+','+typeof root.WebAssembly};return event.request;}", event());
  assert.equal((escaped as any).headers.leak.value, "undefined,undefined,undefined,undefined");
  await assert.rejects(runner.invoke("function handler(event){return process.env;}", event()), /undefined|process/i);
  await assert.rejects(runner.invoke("function handler(event){event.request.method='POST';return event.request;}", event()), /cannot change the request method/);
  await assert.rejects(runner.invoke("function handler(event){event.request.uri='\\bad';return event.request;}", event()), /invalid URI/);
  await assert.rejects(runner.invoke("function handler(event){while(true){} }", event()), /interrupted|timed out|execution failed/i);
  await assert.rejects(runner.invoke("function handler(event){return {value:'x'.repeat(50000)}}", event()), /output exceeds|memory|failed/i);
  await assert.rejects(runner.invoke("function handler(event){var a=[];while(true)a.push('x'.repeat(100000));}", event()), /memory|interrupted|timed out|failed/i);
  await assert.rejects(runner.invoke("x".repeat(CLOUDFRONT_FUNCTION_LIMITS.maximumCodeBytes + 1), event()), /10 KiB/);
  const oversized = event(); oversized.request.headers.large = { value: "x".repeat(CLOUDFRONT_FUNCTION_LIMITS.maximumEventBytes) };
  await assert.rejects(runner.invoke("function handler(event){return event.request;}", oversized), /event exceeds/);
});

test("managed cache policies, bounded LRU, fill fences, invalidation matching, and security headers are deterministic", () => {
  assert.deepEqual(Object.keys(MANAGED_CACHE_POLICIES).sort(), [CACHING_DISABLED_ID, CACHING_OPTIMIZED_ID].sort());
  assert.equal(MANAGED_CACHE_POLICIES[CACHING_DISABLED_ID].CachePolicyConfig.DefaultTTL, 0);
  assert.deepEqual({
    min: MANAGED_CACHE_POLICIES[CACHING_OPTIMIZED_ID].CachePolicyConfig.MinTTL,
    default: MANAGED_CACHE_POLICIES[CACHING_OPTIMIZED_ID].CachePolicyConfig.DefaultTTL,
    max: MANAGED_CACHE_POLICIES[CACHING_OPTIMIZED_ID].CachePolicyConfig.MaxTTL,
  }, { min: 1, default: 86_400, max: 31_536_000 });

  let now = 1_000; const cache = new CloudFrontCache(2, 8, () => now);
  assert.equal(cache.publish("a", "D1", "/assets/a.js", { status: 200, headers: { etag: "a" }, body: Buffer.from("aaaa"), expiresAt: 2_000 }, 0), true);
  assert.equal(cache.publish("b", "D1", "/assets/b.js", { status: 200, headers: {}, body: Buffer.from("bbbb"), expiresAt: 2_000 }, 0), true);
  now += 1;
  assert.equal(cache.lookup("a", "D1")?.headers.etag, "a");
  now += 1; assert.equal(cache.publish("c", "D1", "/runtime-config.json", { status: 200, headers: {}, body: Buffer.from("cccc"), expiresAt: 2_000 }, 0), true);
  assert.equal(cache.lookup("b", "D1"), undefined, "least-recently-used entry must be evicted first");
  const staleFence = cache.generation("D1"); assert.equal(cache.invalidate("D1", ["/assets/*"]), 1); assert.equal(cache.publish("late", "D1", "/assets/late.js", { status: 200, headers: {}, body: Buffer.from("late"), expiresAt: 2_000 }, staleFence), false);
  assert.equal(cache.lookup("c", "D1")?.status, 200); now = 2_001; assert.equal(cache.lookup("c", "D1"), undefined);
  assert.equal(matchesInvalidation("/*", "/anything"), true); assert.equal(matchesInvalidation("/a*b", "/axxb"), false); assert.equal(matchesInvalidation("/a*b", "/a*b"), true);
  assert.deepEqual(cache.diagnostics("D1"), { entries: 0, bytes: 0, hits: 2, misses: 2, evictions: 1, invalidations: 1, generation: 1 });

  const configured = {
    ContentSecurityPolicy: { ContentSecurityPolicy: "default-src 'self'", Override: true }, ContentTypeOptions: { Override: true }, FrameOptions: { FrameOption: "DENY", Override: true },
    ReferrerPolicy: { ReferrerPolicy: "strict-origin-when-cross-origin", Override: true }, StrictTransportSecurity: { AccessControlMaxAgeSec: 31_536_000, IncludeSubdomains: true, Override: true, Preload: true },
  };
  assert.deepEqual(applySecurityHeaders({ "content-security-policy": "origin", "x-frame-options": "SAMEORIGIN" }, configured), {
    "content-security-policy": "default-src 'self'", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "strict-origin-when-cross-origin", "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
  });
  assert.equal(applySecurityHeaders({ "x-frame-options": "origin" }, { FrameOptions: { FrameOption: "DENY", Override: false } })["x-frame-options"], "origin");
});
