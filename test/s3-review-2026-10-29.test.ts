import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketReplicationCommand,
  GetBucketAccelerateConfigurationCommand,
  GetBucketCorsCommand,
  GetBucketLoggingCommand,
  GetBucketPolicyStatusCommand,
  GetBucketReplicationCommand,
  GetBucketWebsiteCommand,
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutBucketNotificationConfigurationCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  PutBucketWebsiteCommand,
  PutObjectCommand,
  PutObjectRetentionCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { CreateQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { StackSim } from "../src/server.js";
import { signedFetch } from "./helpers/signed-fetch.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-s3-review-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region, authMode: "off", cdkBootstrap: false });
  await simulator.start();
  const endpoint = `http://127.0.0.1:${simulator.port}`;
  const s3 = new S3Client({ endpoint, region, forcePathStyle: true, credentials });
  const raw = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}) => {
    const response = await signedFetch(`${endpoint}${path}`, { ...init, body: init.body as any, service: "s3", region, credentials });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, code: text.match(/<Code>([^<]+)<\/Code>/)?.[1] };
  };
  const disablePublicAccessBlock = (bucket: string) => s3.send(new PutPublicAccessBlockCommand({ Bucket: bucket, PublicAccessBlockConfiguration: { BlockPublicAcls: false, IgnorePublicAcls: false, BlockPublicPolicy: false, RestrictPublicBuckets: false } }));
  return { dataDir, simulator, endpoint, s3, raw, disablePublicAccessBlock, async close() { s3.destroy(); await simulator.stop(); await rm(dataDir, { recursive: true, force: true }); } };
}

const rejectsWith = (code: string) => (error: any) => { assert.equal(error?.Code ?? error?.code ?? error?.name, code, error?.message); return true; };

test("S3-16 unimplemented subresources never reach bucket creation, deletion, or listing", async () => {
  const { s3, raw, close } = await fixture();
  try {
    await s3.send(new CreateBucketCommand({ Bucket: "routing", CreateBucketConfiguration: { LocationConstraint: region } }));
    await assert.rejects(s3.send(new GetBucketReplicationCommand({ Bucket: "routing" })), rejectsWith("ReplicationConfigurationNotFoundError"));
    assert.equal((await s3.send(new GetBucketLoggingCommand({ Bucket: "routing" }))).LoggingEnabled, undefined);
    assert.equal((await s3.send(new GetBucketAccelerateConfigurationCommand({ Bucket: "routing" }))).Status, undefined);
    assert.equal((await raw("/routing?inventory&id=x")).code, "NoSuchConfiguration");
    assert.equal((await raw("/routing?metrics")).status, 501);
    const accelerate = await raw("/routing?accelerate", { method: "PUT", body: "<AccelerateConfiguration><Status>Enabled</Status></AccelerateConfiguration>" });
    assert.equal(accelerate.status, 501); assert.equal(accelerate.code, "NotImplemented");
    await assert.rejects(s3.send(new DeleteBucketReplicationCommand({ Bucket: "routing" })), rejectsWith("NotImplemented"));
    assert.equal((await s3.send(new HeadBucketCommand({ Bucket: "routing" }))).$metadata.httpStatusCode, 200, "the bucket must survive DeleteBucketReplication");
    assert.equal((await raw("/routing?replication", { method: "DELETE" })).status, 501);
    assert.equal((await raw("/missing-bucket?replication")).code, "NoSuchBucket");
    await s3.send(new PutObjectCommand({ Bucket: "routing", Key: "data.csv", Body: "a,b\n1,2" }));
    const select = await raw("/routing/data.csv?select&select-type=2", { method: "POST", body: "<SelectObjectContentRequest/>" });
    assert.equal(select.status, 501); assert.equal(select.code, "NotImplemented");
  } finally { await close(); }
});

test("S3-16 new buckets block public access by default and reject public ACLs at creation", async () => {
  const { s3, simulator, raw, disablePublicAccessBlock, close } = await fixture();
  try {
    await s3.send(new CreateBucketCommand({ Bucket: "fresh", CreateBucketConfiguration: { LocationConstraint: region } }));
    assert.deepEqual((await s3.send(new GetPublicAccessBlockCommand({ Bucket: "fresh" }))).PublicAccessBlockConfiguration, { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true });
    const publicPolicy = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "arn:aws:s3:::fresh/*" }] });
    await assert.rejects(s3.send(new PutBucketPolicyCommand({ Bucket: "fresh", Policy: publicPolicy })), rejectsWith("AccessDenied"));
    await disablePublicAccessBlock("fresh");
    await s3.send(new PutBucketPolicyCommand({ Bucket: "fresh", Policy: publicPolicy }));
    const locationBody = `<CreateBucketConfiguration><LocationConstraint>${region}</LocationConstraint></CreateBucketConfiguration>`;
    const publicAcl = await raw("/public-acl", { method: "PUT", body: locationBody, headers: { "x-amz-object-ownership": "ObjectWriter", "x-amz-acl": "public-read" } });
    assert.equal(publicAcl.status, 403); assert.equal(publicAcl.code, "AccessDenied");
    const privateAcl = await raw("/private-acl", { method: "PUT", body: locationBody, headers: { "x-amz-object-ownership": "ObjectWriter", "x-amz-acl": "private" } });
    assert.equal(privateAcl.status, 200);
    const internal = await simulator.s3.createBucketInternal({ name: "cfn-default", versioning: "unversioned", encryption: "AES256" });
    assert.deepEqual(internal.publicAccessBlock, { blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: true, restrictPublicBuckets: true });
    const explicit = await simulator.s3.createBucketInternal({ name: "cfn-explicit", versioning: "unversioned", encryption: "AES256", publicAccessBlock: { blockPublicAcls: true } });
    assert.deepEqual(explicit.publicAccessBlock, { blockPublicAcls: true, ignorePublicAcls: false, blockPublicPolicy: false, restrictPublicBuckets: false });
    // A later update without the property keeps whatever the bucket currently has.
    await s3.send(new PutPublicAccessBlockCommand({ Bucket: "cfn-default", PublicAccessBlockConfiguration: { BlockPublicAcls: false, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } }));
    const updated = await simulator.s3.updateBucketInternal("cfn-default", { versioning: "enabled", encryption: "AES256" });
    assert.deepEqual(updated.publicAccessBlock, { blockPublicAcls: false, ignorePublicAcls: true, blockPublicPolicy: true, restrictPublicBuckets: true });
  } finally { await close(); }
});

test("S3-16 CloudFront origin reads enforce SSE-C keys and archive restore state", async () => {
  const { s3, simulator, close } = await fixture();
  try {
    const bucket = "origin"; const accountId = simulator.store.accountId; const distributionArn = `arn:aws:cloudfront::${accountId}:distribution/E1ORIGINTEST`;
    await s3.send(new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: region } }));
    await s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "cloudfront.amazonaws.com" }, Action: "s3:GetObject", Resource: `arn:aws:s3:::${bucket}/*`, Condition: { StringEquals: { "AWS:SourceArn": distributionArn } } }] }) }));
    const key = Buffer.alloc(32, 7); const keyMd5 = (await import("node:crypto")).createHash("md5").update(key).digest("base64");
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "plain.html", Body: "<p>ok</p>" }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "secret.html", Body: "<p>secret</p>", SSECustomerAlgorithm: "AES256", SSECustomerKey: key.toString("base64"), SSECustomerKeyMD5: keyMd5 }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "cold.html", Body: "<p>cold</p>", StorageClass: "GLACIER" }));
    const origin = simulator.s3.createCloudFrontOriginPort();
    const request = (objectKey: string) => origin.request({ accountId, bucketRegion: region, bucketName: bucket, key: objectKey, distributionArn, method: "GET", headers: {}, maximumBytes: 1024 });
    assert.equal((await request("plain.html")).status, 200);
    await assert.rejects(request("secret.html"), rejectsWith("InvalidRequest"));
    await assert.rejects(request("cold.html"), rejectsWith("InvalidObjectState"));
  } finally { await close(); }
});

test("S3-17 lifecycle configurations reject the shapes AWS rejects", async () => {
  const { s3, raw, close } = await fixture();
  try {
    await s3.send(new CreateBucketCommand({ Bucket: "lifecycle", CreateBucketConfiguration: { LocationConstraint: region } }));
    const put = (rule: string) => raw("/lifecycle?lifecycle", { method: "PUT", body: `<LifecycleConfiguration><Rule><ID>r</ID>${rule}</Rule></LifecycleConfiguration>` });
    for (const [label, rule] of [
      ["no Filter or Prefix", "<Status>Enabled</Status><Expiration><Days>1</Days></Expiration>"],
      ["Days and Date", "<Filter><Prefix></Prefix></Filter><Status>Enabled</Status><Expiration><Days>1</Days><Date>2030-01-01T00:00:00Z</Date></Expiration>"],
      ["ExpiredObjectDeleteMarker with Days", "<Filter><Prefix></Prefix></Filter><Status>Enabled</Status><Expiration><Days>1</Days><ExpiredObjectDeleteMarker>true</ExpiredObjectDeleteMarker></Expiration>"],
      ["noncurrent transition without NoncurrentDays", "<Filter><Prefix></Prefix></Filter><Status>Enabled</Status><NoncurrentVersionTransition><StorageClass>GLACIER</StorageClass></NoncurrentVersionTransition>"],
    ] as const) {
      const result = await put(rule);
      assert.equal(result.status, 400, label); assert.equal(result.code, "MalformedXML", label);
    }
    assert.equal((await put("<Prefix>legacy/</Prefix><Status>Enabled</Status><Expiration><Days>1</Days></Expiration>")).status, 200, "a top-level Prefix satisfies the filter requirement");
    assert.equal((await put("<Filter><Prefix></Prefix></Filter><Status>Enabled</Status><Expiration><ExpiredObjectDeleteMarker>true</ExpiredObjectDeleteMarker></Expiration><NoncurrentVersionTransition><NoncurrentDays>30</NoncurrentDays><StorageClass>GLACIER</StorageClass></NoncurrentVersionTransition>")).status, 200);
  } finally { await close(); }
});

test("S3-17 annotations follow the published naming, limit, encryption, and copy rules", async () => {
  const { s3, raw, close } = await fixture();
  try {
    await s3.send(new CreateBucketCommand({ Bucket: "notes", CreateBucketConfiguration: { LocationConstraint: region } }));
    await s3.send(new PutObjectCommand({ Bucket: "notes", Key: "doc.txt", Body: "document" }));
    const put = (name: string, headers: Record<string, string> = {}) => raw(`/notes/doc.txt?annotation&annotationName=${encodeURIComponent(name)}`, { method: "PUT", body: "{\"label\":\"ok\"}", headers });
    for (const name of ["aws-label", "S3label", "bad name", "slash/name", " "]) assert.equal((await put(name)).code, "InvalidAnnotationName", name);
    assert.equal((await put("review.v1_final-ok")).status, 200);
    assert.equal((await put("étiquette")).status, 200, "letters in any language are allowed");
    assert.equal((await put("digest", { "x-amz-checksum-algorithm": "MD5" })).code, "InvalidRequest");
    const key = Buffer.alloc(32, 3); const keyMd5 = (await import("node:crypto")).createHash("md5").update(key).digest("base64");
    await s3.send(new PutObjectCommand({ Bucket: "notes", Key: "secret.txt", Body: "x", SSECustomerAlgorithm: "AES256", SSECustomerKey: key.toString("base64"), SSECustomerKeyMD5: keyMd5 }));
    const sseC = await raw("/notes/secret.txt?annotation&annotationName=review", { method: "PUT", body: "{}", headers: { "x-amz-server-side-encryption-customer-algorithm": "AES256", "x-amz-server-side-encryption-customer-key": key.toString("base64"), "x-amz-server-side-encryption-customer-key-md5": keyMd5 } });
    assert.equal(sseC.code, "InvalidRequest");
    await s3.send(new CopyObjectCommand({ Bucket: "notes", Key: "copy.txt", CopySource: "/notes/doc.txt" }));
    assert.match((await raw("/notes/copy.txt?annotation")).text, /<AnnotationName>review\.v1_final-ok<\/AnnotationName>/, "CopyObject copies annotations by default");
    await s3.send(new CopyObjectCommand({ Bucket: "notes", Key: "bare.txt", CopySource: "/notes/doc.txt", ...( { AnnotationDirective: "EXCLUDE" } as any) }));
    const excluded = await raw("/notes/bare2.txt", { method: "PUT", headers: { "x-amz-copy-source": "/notes/doc.txt", "x-amz-annotation-directive": "EXCLUDE" } });
    assert.equal(excluded.status, 200);
    assert.doesNotMatch((await raw("/notes/bare2.txt?annotation")).text, /<AnnotationName>/, "EXCLUDE leaves the copy without annotations");
  } finally { await close(); }
});

test("S3-17 retention events, policy status, ListBuckets shape, conditional writes, multipart defaults, and tagging status", async () => {
  const { s3, endpoint, raw, close } = await fixture();
  const sqs = new SQSClient({ endpoint, region, credentials });
  try {
    await s3.send(new CreateBucketCommand({ Bucket: "locked", CreateBucketConfiguration: { LocationConstraint: region }, ObjectLockEnabledForBucket: true }));
    await assert.rejects(s3.send(new GetBucketPolicyStatusCommand({ Bucket: "locked" })), rejectsWith("NoSuchBucketPolicy"));
    const listing = await raw("/");
    assert.match(listing.text, /<BucketArn>arn:aws:s3:::locked<\/BucketArn>/);
    assert.doesNotMatch(listing.text, /ObjectLockEnabled|LifecycleConfigured|BucketTags/, "ListBuckets carries only the documented elements");

    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "retention-events" }));
    const queueArn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queue.QueueUrl, AttributeNames: ["QueueArn"] }))).Attributes!.QueueArn!;
    await sqs.send(new SetQueueAttributesCommand({ QueueUrl: queue.QueueUrl, Attributes: { Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "s3.amazonaws.com" }, Action: "sqs:SendMessage", Resource: queueArn, Condition: { ArnLike: { "aws:SourceArn": "arn:aws:s3:::locked" } } }] }) } }));
    await s3.send(new PutBucketNotificationConfigurationCommand({ Bucket: "locked", NotificationConfiguration: { QueueConfigurations: [{ Id: "retention", QueueArn: queueArn, Events: ["s3:ObjectRetention:Put" as any] }] } }));
    const written = await s3.send(new PutObjectCommand({ Bucket: "locked", Key: "evidence.txt", Body: "keep" }));
    const retainUntil = new Date(Date.now() + 86_400_000);
    await s3.send(new PutObjectRetentionCommand({ Bucket: "locked", Key: "evidence.txt", VersionId: written.VersionId, Retention: { Mode: "GOVERNANCE", RetainUntilDate: retainUntil } }));
    const records: any[] = [];
    for (let attempt = 0; attempt < 20 && !records.some(record => record.eventName === "ObjectRetention:Put"); attempt++) {
      const messages = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queue.QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
      for (const message of messages.Messages ?? []) { const body = JSON.parse(message.Body!); records.push(...(body.Records ?? [body])); }
    }
    const retention = records.find(record => record.eventName === "ObjectRetention:Put");
    assert.ok(retention, "PutObjectRetention publishes s3:ObjectRetention:Put");
    assert.equal(retention.objectRetentionEventData.mode, "GOVERNANCE");
    assert.equal(retention.objectRetentionEventData.retainUntilDate, retainUntil.toISOString());
    assert.equal(retention.s3.object.retention, undefined);

    await s3.send(new CreateBucketCommand({ Bucket: "cond", CreateBucketConfiguration: { LocationConstraint: region } }));
    const missing = await raw("/cond/missing.txt", { method: "PUT", body: "x", headers: { "if-match": '"abc"' } });
    assert.equal(missing.status, 404); assert.equal(missing.code, "NoSuchKey");
    const existing = await raw("/cond/present.txt", { method: "PUT", body: "x" });
    const specific = await raw("/cond/present.txt", { method: "PUT", body: "y", headers: { "if-none-match": existing.headers.get("etag")! } });
    assert.equal(specific.status, 501); assert.equal(specific.code, "NotImplemented");
    assert.equal((await raw("/cond/present.txt", { method: "PUT", body: "y", headers: { "if-none-match": "*" } })).status, 412);
    const upload = await s3.send(new CreateMultipartUploadCommand({ Bucket: "cond", Key: "present.txt" }));
    assert.equal(upload.ChecksumAlgorithm, undefined, "no algorithm is reported until one is declared or adopted");
    const part = await s3.send(new UploadPartCommand({ Bucket: "cond", Key: "present.txt", UploadId: upload.UploadId, PartNumber: 1, Body: "multipart" }));
    await assert.rejects(s3.send(new CompleteMultipartUploadCommand({ Bucket: "cond", Key: "present.txt", UploadId: upload.UploadId, IfNoneMatch: "*", MultipartUpload: { Parts: [{ PartNumber: 1, ETag: part.ETag }] } })), rejectsWith("PreconditionFailed"));
    // Parts uploaded without any checksum complete with the CRC64NVME full-object default.
    const plain = await s3.send(new CreateMultipartUploadCommand({ Bucket: "cond", Key: "plain.bin" }));
    const rawPart = await raw(`/cond/plain.bin?partNumber=1&uploadId=${encodeURIComponent(plain.UploadId!)}`, { method: "PUT", body: "multipart" });
    const completed = await raw(`/cond/plain.bin?uploadId=${encodeURIComponent(plain.UploadId!)}`, { method: "POST", body: `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${rawPart.headers.get("etag")}</ETag></Part></CompleteMultipartUpload>` });
    assert.equal(completed.status, 200); assert.match(completed.text, /<ChecksumCRC64NVME>/); assert.match(completed.text, /<ChecksumType>FULL_OBJECT<\/ChecksumType>/);
    assert.equal((await raw("/cond?tagging", { method: "PUT", body: "<Tagging><TagSet><Tag><Key>a</Key><Value>b</Value></Tag></TagSet></Tagging>" })).status, 204);
  } finally { sqs.destroy(); await close(); }
});

test("S3-09 CORS rules evaluate in stored order on preflight and actual requests", async () => {
  const { s3, endpoint, raw, close } = await fixture();
  try {
    await s3.send(new CreateBucketCommand({ Bucket: "cors", CreateBucketConfiguration: { LocationConstraint: region } }));
    await assert.rejects(s3.send(new PutBucketCorsCommand({ Bucket: "cors", CORSConfiguration: { CORSRules: [{ AllowedOrigins: ["*"], AllowedMethods: ["PATCH"] }] } })), rejectsWith("InvalidRequest"));
    await s3.send(new PutBucketCorsCommand({ Bucket: "cors", CORSConfiguration: { CORSRules: [
      { ID: "app", AllowedOrigins: ["https://app.example.com"], AllowedMethods: ["GET", "PUT", "POST"], AllowedHeaders: ["*"], ExposeHeaders: ["ETag", "x-amz-version-id"], MaxAgeSeconds: 3000 },
      { AllowedOrigins: ["https://*.example.org"], AllowedMethods: ["GET"], AllowedHeaders: ["Authorization"] },
      { AllowedOrigins: ["*"], AllowedMethods: ["HEAD"] },
    ] } }));
    const stored = (await s3.send(new GetBucketCorsCommand({ Bucket: "cors" }))).CORSRules!;
    assert.equal(stored.length, 3); assert.equal(stored[0].ID, "app"); assert.deepEqual(stored[0].ExposeHeaders, ["ETag", "x-amz-version-id"]); assert.equal(stored[0].MaxAgeSeconds, 3000);
    await s3.send(new PutObjectCommand({ Bucket: "cors", Key: "asset.txt", Body: "asset" }));
    // Browser preflights are unsigned path-style requests.
    const preflight = await fetch(`${endpoint}/cors/asset.txt`, { method: "OPTIONS", headers: { origin: "https://app.example.com", "access-control-request-method": "PUT", "access-control-request-headers": "content-type, x-amz-meta-owner" } });
    assert.equal(preflight.status, 200);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://app.example.com");
    assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, PUT, POST");
    assert.equal(preflight.headers.get("access-control-allow-headers"), "content-type, x-amz-meta-owner");
    assert.equal(preflight.headers.get("access-control-expose-headers"), "ETag, x-amz-version-id");
    assert.equal(preflight.headers.get("access-control-max-age"), "3000");
    assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
    const wildcard = await fetch(`${endpoint}/cors/asset.txt`, { method: "OPTIONS", headers: { origin: "https://docs.example.org", "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
    assert.equal(wildcard.status, 200); assert.equal(wildcard.headers.get("access-control-allow-methods"), "GET");
    const headerDenied = await fetch(`${endpoint}/cors/asset.txt`, { method: "OPTIONS", headers: { origin: "https://docs.example.org", "access-control-request-method": "GET", "access-control-request-headers": "x-custom" } });
    assert.equal(headerDenied.status, 403);
    assert.match(await headerDenied.text(), /CORSResponse: This CORS request is not allowed/);
    const anyOrigin = await fetch(`${endpoint}/cors/asset.txt`, { method: "OPTIONS", headers: { origin: "https://elsewhere.test", "access-control-request-method": "HEAD" } });
    assert.equal(anyOrigin.headers.get("access-control-allow-origin"), "*"); assert.equal(anyOrigin.headers.get("access-control-allow-credentials"), null);
    const denied = await fetch(`${endpoint}/cors/asset.txt`, { method: "OPTIONS", headers: { origin: "https://elsewhere.test", "access-control-request-method": "DELETE" } });
    assert.equal(denied.status, 403);
    const actual = await raw("/cors/asset.txt", { headers: { origin: "https://app.example.com" } });
    assert.equal(actual.headers.get("access-control-allow-origin"), "https://app.example.com"); assert.equal(actual.headers.get("access-control-expose-headers"), "ETag, x-amz-version-id");
    const bucketLevel = await raw("/cors?list-type=2", { headers: { origin: "https://app.example.com" } });
    assert.equal(bucketLevel.headers.get("access-control-allow-origin"), "https://app.example.com", "bucket requests carry CORS headers too");
    assert.equal((await raw("/cors/asset.txt", { headers: { origin: "https://nope.test" } })).headers.get("access-control-allow-origin"), null);
  } finally { await close(); }
});

test("S3-09 website endpoint supports redirect-all, redirection rules, object redirects, and HTML error pages", async () => {
  const { s3, endpoint, disablePublicAccessBlock, close } = await fixture();
  try {
    const bucket = "site"; const base = `${endpoint}/_stacksim/s3-website/${bucket}/`;
    await s3.send(new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: region } }));
    await disablePublicAccessBlock(bucket);
    await s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: `arn:aws:s3:::${bucket}/*` }] }) }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "index.html", Body: "<h1>home</h1>", ContentType: "text/html" }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "documents/a.html", Body: "<h1>a</h1>", ContentType: "text/html" }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "old.html", Body: "", WebsiteRedirectLocation: "/documents/a.html" }));
    await assert.rejects(s3.send(new PutBucketWebsiteCommand({ Bucket: bucket, WebsiteConfiguration: { IndexDocument: { Suffix: "index.html" }, RedirectAllRequestsTo: { HostName: "example.com" } } })), rejectsWith("InvalidRequest"));
    await s3.send(new PutBucketWebsiteCommand({ Bucket: bucket, WebsiteConfiguration: { RedirectAllRequestsTo: { HostName: "example.com", Protocol: "https" } } }));
    const redirectAll = await fetch(`${base}some/path.html`, { redirect: "manual" });
    assert.equal(redirectAll.status, 301); assert.equal(redirectAll.headers.get("location"), "https://example.com/some/path.html");
    assert.equal((await s3.send(new GetBucketWebsiteCommand({ Bucket: bucket }))).RedirectAllRequestsTo?.Protocol, "https");

    await s3.send(new PutBucketWebsiteCommand({ Bucket: bucket, WebsiteConfiguration: { IndexDocument: { Suffix: "index.html" }, ErrorDocument: { Key: "error.html" }, RoutingRules: [
      { Condition: { KeyPrefixEquals: "docs/" }, Redirect: { ReplaceKeyPrefixWith: "documents/" } },
      { Condition: { HttpErrorCodeReturnedEquals: "404", KeyPrefixEquals: "legacy/" }, Redirect: { HostName: "archive.example.com", ReplaceKeyWith: "gone.html", HttpRedirectCode: "302" } },
    ] } }));
    const website = await s3.send(new GetBucketWebsiteCommand({ Bucket: bucket }));
    assert.equal(website.RoutingRules?.length, 2); assert.equal(website.RoutingRules?.[1].Redirect?.HttpRedirectCode, "302");
    assert.equal((await fetch(base)).status, 200);
    const prefix = await fetch(`${base}docs/a.html`, { redirect: "manual" });
    assert.equal(prefix.status, 301); assert.equal(prefix.headers.get("location"), `${base}documents/a.html`);
    const legacy = await fetch(`${base}legacy/page.html`, { redirect: "manual" });
    assert.equal(legacy.status, 302); assert.equal(legacy.headers.get("location"), "http://archive.example.com/gone.html");
    const objectRedirect = await fetch(`${base}old.html`, { redirect: "manual" });
    assert.equal(objectRedirect.status, 301); assert.equal(objectRedirect.headers.get("location"), `${base}documents/a.html`);
    const missing = await fetch(`${base}nope.html`);
    assert.equal(missing.status, 404); assert.match(missing.headers.get("content-type") ?? "", /text\/html/);
    const page = await missing.text();
    assert.match(page, /<h1>404 Not Found<\/h1>/); assert.match(page, /<li>Code: NoSuchKey<\/li>/); assert.match(page, /<li>Key: nope\.html<\/li>/);
    const head = await fetch(`${base}nope.html`, { method: "HEAD" });
    assert.equal(head.status, 404); assert.equal((await head.text()).length, 0);
  } finally { await close(); }
});
