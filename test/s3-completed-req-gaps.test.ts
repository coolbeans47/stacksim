import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketNotificationConfigurationCommand,
  PutBucketOwnershipControlsCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { CreateAccessKeyCommand, CreateUserCommand, IAMClient } from "@aws-sdk/client-iam";
import { CreateQueueCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { TestClock } from "../src/core/clock.js";
import { S3Checksums } from "../src/s3/checksums.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const settle = async () => { for (let index = 0; index < 16; index++) await new Promise<void>(resolve => setImmediate(resolve)); };

async function fixture(options: ConstructorParameters<typeof StackSim>[0] = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-s3-gaps-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", authMode: "off", ...options });
  await simulator.start();
  const endpoint = `http://127.0.0.1:${simulator.port}`;
  const s3 = new S3Client({ endpoint, region: "eu-west-1", forcePathStyle: true, credentials });
  return {
    dataDir, simulator, endpoint, s3,
    async close() { s3.destroy(); await simulator.stop(); await rm(dataDir, { recursive: true, force: true }); },
  };
}

function rawHttp(url: string, options: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: options.method, headers: options.headers }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function hmac(key: string | Buffer, value: string): Buffer { return createHmac("sha256", key).update(value).digest(); }
function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), "aws4_request");
}

function signChunk(key: Buffer, amzDate: string, scope: string, previous: string, payload: Buffer | ""): string {
  const stringToSign = `AWS4-HMAC-SHA256-PAYLOAD\n${amzDate}\n${scope}\n${previous}\n${hash("")}\n${hash(payload)}`;
  return createHmac("sha256", key).update(stringToSign).digest("hex");
}

function signTrailer(key: Buffer, amzDate: string, scope: string, previous: string, canonicalTrailers: string): string {
  const stringToSign = `AWS4-HMAC-SHA256-TRAILER\n${amzDate}\n${scope}\n${previous}\n${hash(canonicalTrailers)}`;
  return createHmac("sha256", key).update(stringToSign).digest("hex");
}

async function signedStreamingPut(options: {
  endpoint: string;
  bucket: string;
  key: string;
  body: Buffer;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  trailerSignature?: string | "omit" | "mutate";
}): Promise<{ status: number; body: string }> {
  const region = options.region ?? "eu-west-1";
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const payloadHash = "STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER";
  const checksumEngine = new S3Checksums(); await checksumEngine.update(options.body); const checksum = (await checksumEngine.digest()).values.CRC32!;
  const host = new URL(options.endpoint).host;
  const canonicalHeaders = [
    "content-encoding:aws-chunked",
    `host:${host}`,
    "x-amz-content-sha256:" + payloadHash,
    `x-amz-date:${amzDate}`,
    `x-amz-decoded-content-length:${options.body.length}`,
    "x-amz-sdk-checksum-algorithm:CRC32",
    "x-amz-trailer:x-amz-checksum-crc32",
  ].sort().map(line => `${line}\n`).join("");
  const signedHeaders = "content-encoding;host;x-amz-content-sha256;x-amz-date;x-amz-decoded-content-length;x-amz-sdk-checksum-algorithm;x-amz-trailer";
  const canonicalRequest = `PUT\n/${options.bucket}/${options.key}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hash(canonicalRequest)}`;
  const key = signingKey(options.secretAccessKey, date, region, "s3");
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  let previous = signature;
  const dataSig = signChunk(key, amzDate, scope, previous, options.body);
  previous = dataSig;
  const emptySig = signChunk(key, amzDate, scope, previous, "");
  previous = emptySig;
  const trailerHeader = `x-amz-checksum-crc32:${checksum}\n`;
  let trailerSig = signTrailer(key, amzDate, scope, previous, trailerHeader);
  if (options.trailerSignature === "mutate") trailerSig = "ff".repeat(32);
  const trailerBlock = options.trailerSignature === "omit"
    ? `x-amz-checksum-crc32:${checksum}\r\n\r\n`
    : `x-amz-checksum-crc32:${checksum}\r\nx-amz-trailer-signature:${trailerSig}\r\n\r\n`;
  const chunked = Buffer.concat([
    Buffer.from(`${options.body.length.toString(16)};chunk-signature=${dataSig}\r\n`),
    options.body,
    Buffer.from("\r\n"),
    Buffer.from(`0;chunk-signature=${emptySig}\r\n`),
    Buffer.from(trailerBlock),
  ]);
  return rawHttp(`${options.endpoint}/${options.bucket}/${options.key}`, {
    method: "PUT",
    headers: {
      host,
      "content-encoding": "aws-chunked",
      "content-length": String(chunked.length),
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      "x-amz-decoded-content-length": String(options.body.length),
      "x-amz-sdk-checksum-algorithm": "CRC32",
      "x-amz-trailer": "x-amz-checksum-crc32",
      authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: chunked,
  });
}

test("S3GAP-01 PutBucketPolicy accepts known IAM user principals", async () => {
  const active = await fixture({ authMode: "enforce", cdkBootstrap: true });
  const iam = new IAMClient({ endpoint: active.endpoint, region: "eu-west-1", credentials });
  const bucket = "s3gap-01-user-policy";
  try {
    await active.s3.send(new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: "eu-west-1" } }));
    await active.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "secret.txt", Body: "allowed" }));
    await iam.send(new CreateUserCommand({ UserName: "reader" }));
    const access = (await iam.send(new CreateAccessKeyCommand({ UserName: "reader" }))).AccessKey!;
    const userArn = `arn:aws:iam::${active.simulator.store.accountId}:user/reader`;
    await assert.rejects(active.s3.send(new PutBucketPolicyCommand({
      Bucket: bucket,
      Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${active.simulator.store.accountId}:user/missing` }, Action: "s3:GetObject", Resource: `arn:aws:s3:::${bucket}/*` }] }),
    })), (error: any) => error.name === "InvalidPrincipal");
    await active.s3.send(new PutBucketPolicyCommand({
      Bucket: bucket,
      Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: userArn }, Action: "s3:GetObject", Resource: `arn:aws:s3:::${bucket}/*` }] }),
    }));
    const reader = new S3Client({ endpoint: active.endpoint, region: "eu-west-1", forcePathStyle: true, credentials: { accessKeyId: access.AccessKeyId!, secretAccessKey: access.SecretAccessKey! } });
    assert.equal(await (await reader.send(new GetObjectCommand({ Bucket: bucket, Key: "secret.txt" }))).Body?.transformToString(), "allowed");
    reader.destroy();
  } finally {
    iam.destroy();
    await active.close();
  }
});

test("S3GAP-02 ListObjectVersions KeyMarker-only skips the marked key group", async () => {
  const active = await fixture();
  const bucket = "s3gap-02-versions";
  try {
    await active.s3.send(new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: "eu-west-1" } }));
    await active.s3.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
    await active.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "a", Body: "a1" }));
    await active.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "a", Body: "a2" }));
    await active.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "b", Body: "b1" }));
    await active.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "c", Body: "c1" }));
    const listed = await active.s3.send(new ListObjectVersionsCommand({ Bucket: bucket, KeyMarker: "a" }));
    assert.deepEqual((listed.Versions ?? []).map(version => version.Key), ["b", "c"]);
    const page = await active.s3.send(new ListObjectVersionsCommand({ Bucket: bucket, MaxKeys: 2 }));
    assert.equal(page.IsTruncated, true);
    const next = await active.s3.send(new ListObjectVersionsCommand({ Bucket: bucket, KeyMarker: page.NextKeyMarker, VersionIdMarker: page.NextVersionIdMarker }));
    assert.ok((next.Versions?.length ?? 0) >= 1);
  } finally {
    await active.close();
  }
});

test("S3GAP-03 notification identity uses requester not owner", async () => {
  const clock = new TestClock(Date.parse("2026-08-10T12:00:00Z"));
  const active = await fixture({ clock });
  const iam = new IAMClient({ endpoint: active.endpoint, region: "eu-west-1", credentials });
  const sqs = new SQSClient({ endpoint: active.endpoint, region: "eu-west-1", credentials });
  const bucket = "s3gap-03-identity";
  try {
    await active.s3.send(new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: "eu-west-1" } }));
    await iam.send(new CreateUserCommand({ UserName: "uploader" }));
    const access = (await iam.send(new CreateAccessKeyCommand({ UserName: "uploader" }))).AccessKey!;
    const user = active.simulator.store.ensureAccount().iam.users.uploader;
    const queueName = "s3gap-03-events";
    const queueArn = `arn:aws:sqs:eu-west-1:${active.simulator.store.accountId}:${queueName}`;
    const queueUrl = (await sqs.send(new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "s3.amazonaws.com" }, Action: "sqs:SendMessage", Resource: queueArn, Condition: { ArnEquals: { "aws:SourceArn": `arn:aws:s3:::${bucket}` }, StringEquals: { "aws:SourceAccount": active.simulator.store.accountId } } }] }),
      },
    }))).QueueUrl!;
    await active.s3.send(new PutBucketNotificationConfigurationCommand({
      Bucket: bucket,
      NotificationConfiguration: {
        QueueConfigurations: [{ Id: "all", QueueArn: queueArn, Events: ["s3:ObjectCreated:Put", "s3:LifecycleExpiration:Delete"] }],
        EventBridgeConfiguration: {},
      },
    }));
    await settle();
    await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10 }));
    const uploader = new S3Client({
      endpoint: active.endpoint,
      region: "eu-west-1",
      forcePathStyle: true,
      credentials: { accessKeyId: access.AccessKeyId!, secretAccessKey: access.SecretAccessKey! },
    });
    await uploader.send(new PutObjectCommand({ Bucket: bucket, Key: "by-user.txt", Body: "hello" }));
    let created: any;
    for (let attempt = 0; attempt < 20 && !created; attempt++) {
      await settle();
      const delivered = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
      const records = delivered.Messages?.flatMap(message => { try { return JSON.parse(message.Body ?? "{}").Records ?? []; } catch { return []; } }) ?? [];
      created = records.find((record: any) => record.eventName === "ObjectCreated:Put");
    }
    assert.ok(created);
    assert.equal(created.userIdentity.principalId, user.userId);
    assert.notEqual(created.userIdentity.principalId, active.simulator.store.regionState("eu-west-1").s3Buckets[bucket].ownerId);
    await active.s3.send(new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: { Rules: [{ ID: "expire", Status: "Enabled", Filter: { Prefix: "by-user" }, Expiration: { Days: 1 } }] },
    }));
    clock.advance(86_400_000);
    await active.simulator.s3.runLifecycleNow();
    let expired: any;
    for (let attempt = 0; attempt < 20 && !expired; attempt++) {
      await settle();
      const lifecycleMessages = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
      const lifecycleRecords = lifecycleMessages.Messages?.flatMap(message => { try { return JSON.parse(message.Body ?? "{}").Records ?? []; } catch { return []; } }) ?? [];
      expired = lifecycleRecords.find((record: any) => String(record.eventName).includes("LifecycleExpiration"));
    }
    assert.ok(expired);
    assert.equal(expired.userIdentity.principalId, "s3.amazonaws.com");
    uploader.destroy();
  } finally {
    iam.destroy();
    sqs.destroy();
    await active.close();
  }
});

test("S3GAP-05 EncodingType=url leaves slashes unencoded", async () => {
  const active = await fixture();
  const bucket = "s3gap-05-encoding";
  try {
    await active.s3.send(new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: "eu-west-1" } }));
    await active.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "a/b/c", Body: "nested" }));
    await active.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "a b", Body: "space" }));
    const listed = await rawHttp(`${active.endpoint}/${bucket}?list-type=2&encoding-type=url`, { headers: { "x-stacksim-service": "s3" } });
    assert.equal(listed.status, 200);
    assert.match(listed.body, /<Key>a\/b\/c<\/Key>/);
    assert.doesNotMatch(listed.body, /<Key>a%2Fb%2Fc<\/Key>/);
    assert.match(listed.body, /<Key>a%20b<\/Key>/);
  } finally {
    await active.close();
  }
});

test("S3GAP-06 streaming trailer signatures are verified", async () => {
  const active = await fixture({ authMode: "validate" });
  const bucket = "s3gap-06-trailer";
  try {
    await active.s3.send(new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: "eu-west-1" } }));
    const body = Buffer.from("trailer-body");
    const ok = await signedStreamingPut({
      endpoint: active.endpoint,
      bucket,
      key: "ok.bin",
      body,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    });
    assert.equal(ok.status, 200, ok.body);
    assert.equal(await (await active.s3.send(new GetObjectCommand({ Bucket: bucket, Key: "ok.bin" }))).Body?.transformToString(), "trailer-body");
    const bad = await signedStreamingPut({
      endpoint: active.endpoint,
      bucket,
      key: "bad.bin",
      body,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      trailerSignature: "mutate",
    });
    assert.equal(bad.status, 403);
    assert.match(bad.body, /SignatureDoesNotMatch/);
  } finally {
    await active.close();
  }
});

test("S3GAP-07 NewerNoncurrentVersions retains the newest noncurrent versions", async () => {
  const clock = new TestClock(Date.parse("2026-01-01T00:00:00Z"));
  const active = await fixture({ clock });
  const bucket = "s3gap-07-newer-noncurrent";
  try {
    await active.s3.send(new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: "eu-west-1" } }));
    await active.s3.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
    for (const body of ["v1", "v2", "v3", "v4", "v5", "current"]) {
      await active.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "obj", Body: body }));
      clock.advance(86_400_000);
    }
    const badRange = await rawHttp(`${active.endpoint}/${bucket}?lifecycle`, {
      method: "PUT",
      headers: { "x-stacksim-service": "s3", "content-type": "application/xml" },
      body: `<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Rule><ID>bad-range</ID><Filter><Prefix></Prefix></Filter><Status>Enabled</Status><NoncurrentVersionExpiration><NoncurrentDays>1</NoncurrentDays><NewerNoncurrentVersions>0</NewerNoncurrentVersions></NoncurrentVersionExpiration></Rule></LifecycleConfiguration>`,
    });
    assert.equal(badRange.status, 400);
    assert.match(badRange.body, /InvalidArgument/);
    const noFilter = await rawHttp(`${active.endpoint}/${bucket}?lifecycle`, {
      method: "PUT",
      headers: { "x-stacksim-service": "s3", "content-type": "application/xml" },
      body: `<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Rule><ID>no-filter</ID><Prefix></Prefix><Status>Enabled</Status><NoncurrentVersionExpiration><NoncurrentDays>1</NoncurrentDays><NewerNoncurrentVersions>2</NewerNoncurrentVersions></NoncurrentVersionExpiration></Rule></LifecycleConfiguration>`,
    });
    assert.equal(noFilter.status, 400);
    assert.match(noFilter.body, /InvalidRequest/);
    await active.s3.send(new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: { Rules: [{ ID: "keep-two", Status: "Enabled", Filter: { Prefix: "" }, NoncurrentVersionExpiration: { NoncurrentDays: 1, NewerNoncurrentVersions: 2 } }] },
    }));
    clock.advance(86_400_000);
    await active.simulator.s3.runLifecycleNow();
    const versions = await active.s3.send(new ListObjectVersionsCommand({ Bucket: bucket }));
    assert.equal(versions.Versions?.length, 3);
  } finally {
    await active.close();
  }
});

test("S3GAP-08 day-0 IA transitions are accepted and chained minima are enforced", async () => {
  const clock = new TestClock(Date.parse("2026-08-10T00:00:00Z"));
  const active = await fixture({ clock });
  const bucket = "s3gap-08-ia-age";
  try {
    await active.s3.send(new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: "eu-west-1" } }));
    await active.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "fresh.txt", Body: "data" }));
    await active.s3.send(new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: { Rules: [{ ID: "day0-ia", Status: "Enabled", Filter: { Prefix: "" }, Transitions: [{ Days: 0, StorageClass: "STANDARD_IA" }] }] },
    }));
    assert.equal((await active.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: "fresh.txt" }))).StorageClass, "STANDARD_IA");
    await assert.rejects(active.s3.send(new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: {
        Rules: [{
          ID: "too-soon",
          Status: "Enabled",
          Filter: { Prefix: "" },
          Transitions: [
            { Days: 0, StorageClass: "STANDARD_IA" },
            { Days: 10, StorageClass: "GLACIER" },
          ],
        }],
      },
    })), (error: any) => error.name === "InvalidArgument");
    await active.s3.send(new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: {
        Rules: [{
          ID: "valid-chain",
          Status: "Enabled",
          Filter: { Prefix: "" },
          Transitions: [
            { Days: 0, StorageClass: "STANDARD_IA" },
            { Days: 30, StorageClass: "GLACIER" },
          ],
        }],
      },
    }));
  } finally {
    await active.close();
  }
});

test("S3GAP-09 bucket policies can condition on s3:x-amz-acl", async () => {
  const active = await fixture({ authMode: "enforce", cdkBootstrap: true });
  const bucket = "s3gap-09-acl-condition";
  try {
    await active.s3.send(new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: "eu-west-1" } }));
    await active.s3.send(new PutBucketOwnershipControlsCommand({ Bucket: bucket, OwnershipControls: { Rules: [{ ObjectOwnership: "ObjectWriter" }] } }));
    await active.s3.send(new PutBucketPolicyCommand({
      Bucket: bucket,
      Policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Principal: { AWS: `arn:aws:iam::${active.simulator.store.accountId}:root` }, Action: "s3:PutObject", Resource: `arn:aws:s3:::${bucket}/*` },
          { Effect: "Deny", Principal: "*", Action: "s3:PutObject", Resource: `arn:aws:s3:::${bucket}/*`, Condition: { StringEquals: { "s3:x-amz-acl": "public-read" } } },
        ],
      }),
    }));
    await assert.rejects(active.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "public.txt", Body: "nope", ACL: "public-read" })), (error: any) => error.name === "AccessDeniedException" || error.name === "AccessDenied");
    await active.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "private.txt", Body: "ok", ACL: "private" }));
  } finally {
    await active.close();
  }
});

test("S3GAP-11 ObjectCreated:Post is rejected from notification configuration", async () => {
  const active = await fixture();
  const sqs = new SQSClient({ endpoint: active.endpoint, region: "eu-west-1", credentials });
  const bucket = "s3gap-11-post";
  try {
    await active.s3.send(new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: "eu-west-1" } }));
    const queueName = "s3gap-11-queue";
    const queueArn = `arn:aws:sqs:eu-west-1:${active.simulator.store.accountId}:${queueName}`;
    await sqs.send(new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "s3.amazonaws.com" }, Action: "sqs:SendMessage", Resource: queueArn, Condition: { ArnEquals: { "aws:SourceArn": `arn:aws:s3:::${bucket}` }, StringEquals: { "aws:SourceAccount": active.simulator.store.accountId } } }] }),
      },
    }));
    await assert.rejects(active.s3.send(new PutBucketNotificationConfigurationCommand({
      Bucket: bucket,
      NotificationConfiguration: { QueueConfigurations: [{ Id: "post", QueueArn: queueArn, Events: ["s3:ObjectCreated:Post"] }] },
    })), (error: any) => error.name === "InvalidArgument");
  } finally {
    sqs.destroy();
    await active.close();
  }
});

test("S3GAP-12 ListObjects v1 omits NextMarker without delimiter", async () => {
  const active = await fixture();
  const bucket = "s3gap-12-next-marker";
  try {
    await active.s3.send(new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: "eu-west-1" } }));
    await active.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "a", Body: "a" }));
    await active.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "b", Body: "b" }));
    const undelimited = await rawHttp(`${active.endpoint}/${bucket}?max-keys=1`, { headers: { "x-stacksim-service": "s3" } });
    assert.equal(undelimited.status, 200);
    assert.match(undelimited.body, /<IsTruncated>true<\/IsTruncated>/);
    assert.doesNotMatch(undelimited.body, /<NextMarker>/);
    const delimited = await rawHttp(`${active.endpoint}/${bucket}?max-keys=1&delimiter=/`, { headers: { "x-stacksim-service": "s3" } });
    assert.equal(delimited.status, 200);
    assert.match(delimited.body, /<NextMarker>a<\/NextMarker>/);
  } finally {
    await active.close();
  }
});
