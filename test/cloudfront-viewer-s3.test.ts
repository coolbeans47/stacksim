import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { CACHING_DISABLED_ID, CACHING_OPTIMIZED_ID } from "../src/cloudfront/model.js";
import { StackSim } from "../src/server.js";
import type { PolicyDocument } from "../src/types.js";

const accountId = "000000000000";
const region = "eu-west-1";

interface ViewerResponse {
  status: number;
  headers: import("node:http").IncomingHttpHeaders;
  body: Buffer;
  peerSubjectAltName?: string;
}

async function viewerRequest(localUrl: string, ca: string, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<ViewerResponse> {
  const local = new URL(localUrl);
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname: "127.0.0.1",
      port: Number(local.port),
      path,
      method,
      servername: local.hostname,
      ca,
      rejectUnauthorized: true,
      headers: { host: local.host, ...headers },
    }, response => {
      const chunks: Buffer[] = [];
      const peerSubjectAltName = (response.socket as import("node:tls").TLSSocket).getPeerCertificate().subjectaltname;
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks), peerSubjectAltName }));
    });
    request.on("error", reject);
    request.end();
  });
}

function distributionConfig(bucket: string, oacId: string, policyId: string, functionArn: string): Record<string, unknown> {
  const originId = "PrivateWebsiteOrigin";
  return {
    CallerReference: "cloudfront-viewer-s3-e2e",
    Origins: [{ DomainName: `${bucket}.s3.${region}.amazonaws.com`, Id: originId, OriginAccessControlId: oacId, S3OriginConfig: { OriginAccessIdentity: "" } }],
    DefaultCacheBehavior: {
      AllowedMethods: ["GET", "HEAD", "OPTIONS"], CachePolicyId: CACHING_DISABLED_ID, Compress: true,
      FunctionAssociations: [{ EventType: "viewer-request", FunctionARN: functionArn }],
      ResponseHeadersPolicyId: policyId, TargetOriginId: originId, ViewerProtocolPolicy: "redirect-to-https",
    },
    CacheBehaviors: [
      { AllowedMethods: ["GET", "HEAD", "OPTIONS"], CachePolicyId: CACHING_OPTIMIZED_ID, Compress: true, PathPattern: "assets/*", ResponseHeadersPolicyId: policyId, TargetOriginId: originId, ViewerProtocolPolicy: "redirect-to-https" },
      { AllowedMethods: ["GET", "HEAD", "OPTIONS"], CachePolicyId: CACHING_DISABLED_ID, Compress: true, PathPattern: "runtime-config.json", ResponseHeadersPolicyId: policyId, TargetOriginId: originId, ViewerProtocolPolicy: "redirect-to-https" },
    ],
    DefaultRootObject: "index.html", Enabled: true, HttpVersion: "http2and3", IsIPV6Enabled: true,
  };
}

function privateOriginPolicy(bucket: string, distributionArn: string): PolicyDocument {
  const bucketArn = `arn:aws:s3:::${bucket}`;
  return {
    Version: "2012-10-17",
    Statement: [
      { Action: "s3:*", Condition: { Bool: { "aws:SecureTransport": "false" } }, Effect: "Deny", Principal: { AWS: "*" }, Resource: [bucketArn, `${bucketArn}/*`] },
      { Action: ["s3:DeleteObject*", "s3:GetBucket*", "s3:List*", "s3:PutBucketPolicy"], Effect: "Allow", Principal: { AWS: `arn:aws:iam::${accountId}:role/CustomS3AutoDeleteObjectsCustomResourceProviderRole3B1BD092` }, Resource: [bucketArn, `${bucketArn}/*`] },
      { Action: "s3:GetObject", Condition: { StringEquals: { "AWS:SourceArn": distributionArn } }, Effect: "Allow", Principal: { Service: "cloudfront.amazonaws.com" }, Resource: `${bucketArn}/*` },
    ],
  };
}

test("CFR-01 local CloudFront viewer executes Function, cache, OAC-authorized S3, headers, compression, invalidation, restart, and destroy", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cloudfront-viewer-s3-"));
  const options = { port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off" as const };
  const bucket = "cloudfront-private-viewer-fixture";
  const index = Buffer.from("<!doctype html><script src=\"/assets/app.js\"></script><main>private shell</main>", "utf8");
  const assetV1 = Buffer.from(`console.log("asset-v1");\n${"x".repeat(2_048)}`, "utf8");
  const assetV2 = Buffer.from(`console.log("asset-v2");\n${"y".repeat(2_048)}`, "utf8");
  let simulator = new StackSim(options);
  let distributionId = "";
  let canonicalDomain = "";
  let localUrl = "";
  try {
    await simulator.start();
    await simulator.s3.createBucketInternal({
      name: bucket, versioning: "unversioned", encryption: "AES256", objectOwnership: "BucketOwnerEnforced",
      publicAccessBlock: { blockPublicAcls: true, blockPublicPolicy: true, ignorePublicAcls: true, restrictPublicBuckets: true },
    });
    await simulator.s3.putObjectBytesInternal(bucket, "index.html", index, { contentType: "text/html; charset=utf-8", cacheControl: "no-cache" });
    await simulator.s3.putObjectBytesInternal(bucket, "assets/app.js", assetV1, { contentType: "application/javascript", cacheControl: "public,max-age=3600,immutable" });
    await simulator.s3.putObjectBytesInternal(bucket, "runtime-config.json", Buffer.from('{"version":"v1"}'), { contentType: "application/json", cacheControl: "no-cache" });

    const anonymous = await fetch(`http://127.0.0.1:${simulator.port}/assets/app.js`, { headers: { host: `${bucket}.localhost`, "x-stacksim-service": "s3" } });
    assert.notEqual(anonymous.status, 200, "the private S3 origin must not become anonymously readable");

    const responsePolicy = await simulator.cloudfront.createResponseHeadersPolicy({
      Name: "viewer-security-policy",
      SecurityHeadersConfig: {
        ContentSecurityPolicy: { ContentSecurityPolicy: "default-src 'self'", Override: true },
        ContentTypeOptions: { Override: true }, FrameOptions: { FrameOption: "DENY", Override: true },
        ReferrerPolicy: { ReferrerPolicy: "strict-origin-when-cross-origin", Override: true },
        StrictTransportSecurity: { AccessControlMaxAgeSec: 31_536_000, IncludeSubdomains: true, Override: true, Preload: true },
      },
    });
    const rewrite = await simulator.cloudfront.createFunction("viewer-spa-rewrite", { Comment: "Rewrite extensionless routes", Runtime: "cloudfront-js-1.0" }, "function handler(event){var uri=event.request.uri;if(uri.indexOf('.')===-1||uri.charAt(uri.length-1)==='/'){event.request.uri='/index.html';}return event.request;}");
    const published = await simulator.cloudfront.publishFunction(rewrite.name, rewrite.development.etag);
    const oac = await simulator.cloudfront.createOriginAccessControl({ Name: "viewer-private-oac", OriginAccessControlOriginType: "s3", SigningBehavior: "always", SigningProtocol: "sigv4" });
    const distribution = await simulator.cloudfront.createDistribution(distributionConfig(bucket, oac.id, responsePolicy.id, published.arn));
    distributionId = distribution.id; canonicalDomain = distribution.domainName;
    assert.match(canonicalDomain, /^d[0-9a-f]+\.cloudfront\.net$/, "the public resource model must retain its AWS-shaped canonical domain");
    const local = simulator.cloudfront.localViewer(distributionId)!;
    localUrl = String(local.localUrl);
    assert.equal(local.canonicalDomainName, canonicalDomain);
    assert.match(localUrl, /^https:\/\/d[0-9a-f]+\.localhost:\d+\/$/, "the loopback HTTPS endpoint must remain a separate tooling surface");
    assert.equal(local.available, true);
    const callbackBroker = (simulator as any).customResourceCallbacks as { caPrivateKeyPath: string };
    if (process.platform !== "win32") assert.equal((await stat(callbackBroker.caPrivateKeyPath)).mode & 0o777, 0o600, "the installation CA signing key must remain owner-only");
    assert.equal(JSON.stringify(simulator.cloudfront.consoleSnapshot()).includes("caPrivateKey"), false, "local diagnostics must never expose CA signing material");
    const ca = await readFile(String(local.caCertificatePath), "utf8");

    await simulator.s3.putBucketPolicyInternal(bucket, privateOriginPolicy(bucket, `arn:aws:cloudfront::${accountId}:distribution/EWRONGSOURCE`));
    assert.equal((await viewerRequest(localUrl, ca, "/deep/link")).status, 403, "OAC fetches require the exact distribution SourceArn");
    await simulator.s3.putBucketPolicyInternal(bucket, privateOriginPolicy(bucket, distribution.arn));

    const deep = await viewerRequest(localUrl, ca, "/deep/link");
    assert.equal(deep.status, 200); assert.deepEqual(deep.body, index); assert.equal(deep.headers["x-cache"], "Miss from cloudfront");
    assert.equal(deep.peerSubjectAltName, `DNS:${new URL(localUrl).hostname}`, "the installation CA must issue one exact-host SAN leaf for the distribution");
    assert.equal(deep.headers["content-security-policy"], "default-src 'self'"); assert.equal(deep.headers["x-content-type-options"], "nosniff");
    assert.equal(deep.headers["x-frame-options"], "DENY"); assert.equal(deep.headers["referrer-policy"], "strict-origin-when-cross-origin");
    assert.equal(deep.headers["strict-transport-security"], "max-age=31536000; includeSubDomains; preload");
    assert.equal((await viewerRequest(localUrl, ca, "/deep/link")).headers["x-cache"], "Miss from cloudfront", "the default CachingDisabled behavior must always refetch");

    const gzipMiss = await viewerRequest(localUrl, ca, "/assets/app.js", { "accept-encoding": "gzip" });
    assert.equal(gzipMiss.status, 200); assert.equal(gzipMiss.headers["content-encoding"], "gzip"); assert.deepEqual(gunzipSync(gzipMiss.body), assetV1); assert.equal(gzipMiss.headers["x-cache"], "Miss from cloudfront");
    const gzipHit = await viewerRequest(localUrl, ca, "/assets/app.js", { "accept-encoding": "gzip" });
    assert.deepEqual(gunzipSync(gzipHit.body), assetV1); assert.equal(gzipHit.headers["x-cache"], "Hit from cloudfront");
    const brotliMiss = await viewerRequest(localUrl, ca, "/assets/app.js", { "accept-encoding": "br, gzip" });
    assert.equal(brotliMiss.headers["content-encoding"], "br"); assert.deepEqual(brotliDecompressSync(brotliMiss.body), assetV1); assert.equal(brotliMiss.headers["x-cache"], "Miss from cloudfront", "managed caching must separate normalized compression variants");

    const runtimeV1 = await viewerRequest(localUrl, ca, "/runtime-config.json"); assert.deepEqual(runtimeV1.body, Buffer.from('{"version":"v1"}')); assert.equal(runtimeV1.headers["x-cache"], "Miss from cloudfront");
    await simulator.s3.putObjectBytesInternal(bucket, "runtime-config.json", Buffer.from('{"version":"v2"}'), { contentType: "application/json", cacheControl: "no-cache" });
    const runtimeV2 = await viewerRequest(localUrl, ca, "/runtime-config.json"); assert.deepEqual(runtimeV2.body, Buffer.from('{"version":"v2"}')); assert.equal(runtimeV2.headers["x-cache"], "Miss from cloudfront");

    await simulator.s3.putObjectBytesInternal(bucket, "assets/app.js", assetV2, { contentType: "application/javascript", cacheControl: "public,max-age=3600,immutable" });
    assert.deepEqual(gunzipSync((await viewerRequest(localUrl, ca, "/assets/app.js", { "accept-encoding": "gzip" })).body), assetV1, "a warm optimized entry must remain until invalidated");
    const invalidation = await simulator.cloudfront.createInvalidation(distributionId, ["/assets/*"], "asset-v2-invalidation");
    assert.equal(invalidation.status, "Completed");
    const afterInvalidation = await viewerRequest(localUrl, ca, "/assets/app.js", { "accept-encoding": "gzip" });
    assert.equal(afterInvalidation.headers["x-cache"], "Miss from cloudfront"); assert.deepEqual(gunzipSync(afterInvalidation.body), assetV2);
    const head = await viewerRequest(localUrl, ca, "/", {}, "HEAD"); assert.equal(head.status, 200); assert.equal(head.body.length, 0);

    await simulator.stop();
    simulator = new StackSim(options); await simulator.start();
    const rebound = simulator.cloudfront.localViewer(distributionId)!;
    assert.equal(rebound.canonicalDomainName, canonicalDomain); assert.equal(rebound.localUrl, localUrl); assert.equal(rebound.available, true, "restart must rebind the persisted per-distribution port");
    const reboundCa = await readFile(String(rebound.caCertificatePath), "utf8");
    const cold = await viewerRequest(localUrl, reboundCa, "/assets/app.js", { "accept-encoding": "gzip" });
    assert.equal(cold.headers["x-cache"], "Miss from cloudfront", "the bounded edge cache is rebuildable process-local state"); assert.deepEqual(gunzipSync(cold.body), assetV2);

    const current = simulator.cloudfront.getDistribution(distributionId);
    await simulator.cloudfront.updateDistribution(distributionId, { ...current.config, Enabled: false }, current.etag);
    const disabled = simulator.cloudfront.getDistribution(distributionId);
    await simulator.cloudfront.deleteDistribution(distributionId, disabled.etag);
    assert.equal(simulator.cloudfront.localViewer(distributionId), undefined);
    await assert.rejects(viewerRequest(localUrl, reboundCa, "/"), /ECONNREFUSED|ECONNRESET|socket|connect/i, "destroy must release the dedicated viewer listener");
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
