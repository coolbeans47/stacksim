import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CreateBucketCommand,
  DeleteBucketPolicyCommand,
  DeleteBucketTaggingCommand,
  DeleteBucketWebsiteCommand,
  DeletePublicAccessBlockCommand,
  GetBucketPolicyCommand,
  GetBucketTaggingCommand,
  GetBucketWebsiteCommand,
  GetPublicAccessBlockCommand,
  PutBucketPolicyCommand,
  PutBucketTaggingCommand,
  PutBucketVersioningCommand,
  PutBucketWebsiteCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

function client(simulator: StackSim): S3Client {
  return new S3Client({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, forcePathStyle: true });
}

test("S3 bucket control-plane state and anonymous website bytes are durable and SDK-compatible", { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-s3-website-"));
  const options = { port: 0, invokePort: 0, dataDir, region, authMode: "off" as const };
  let simulator = new StackSim(options);
  let s3: S3Client | undefined;
  const bucket = "service-public-react-site";
  const policy = {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { AWS: "*" }, Action: "s3:GetObject", Resource: `arn:aws:s3:::${bucket}/*` }],
  };
  try {
    await simulator.start(); s3 = client(simulator);
    const recoveryBucket = "service-interrupted-create";
    const storage = simulator.s3.storage as any;
    const saveBucket = storage.saveBucket.bind(storage);
    let interrupt = true;
    storage.saveBucket = async (...args: any[]) => {
      if (interrupt && args[2] === recoveryBucket) { interrupt = false; throw new Error("simulated initial index interruption"); }
      return saveBucket(...args);
    };
    const recoveryInput = { name: recoveryBucket, versioning: "enabled" as const, encryption: "AES256" as const, tags: { owner: "fixture" }, publicAccessBlock: { blockPublicAcls: true, ignorePublicAcls: true }, website: { indexDocument: "index.html" } };
    await assert.rejects(simulator.s3.createBucketInternal(recoveryInput), /simulated initial index interruption/);
    await simulator.store.flush(); storage.saveBucket = saveBucket;
    assert.equal((await simulator.s3.createBucketInternal(recoveryInput)).name, recoveryBucket, "exact owned replay must repair a missing initial bucket index");
    await simulator.s3.deleteBucketInternal(recoveryBucket);

    await s3.send(new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: region } }));
    await s3.send(new PutBucketTaggingCommand({ Bucket: bucket, Tagging: { TagSet: [{ Key: "application", Value: "react" }] } }));
    assert.deepEqual((await s3.send(new GetBucketTaggingCommand({ Bucket: bucket }))).TagSet, [{ Key: "application", Value: "react" }]);
    await s3.send(new PutPublicAccessBlockCommand({ Bucket: bucket, PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: false, RestrictPublicBuckets: false } }));
    assert.deepEqual((await s3.send(new GetPublicAccessBlockCommand({ Bucket: bucket }))).PublicAccessBlockConfiguration, { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: false, RestrictPublicBuckets: false });
    await s3.send(new PutBucketWebsiteCommand({ Bucket: bucket, WebsiteConfiguration: { IndexDocument: { Suffix: "index.html" }, ErrorDocument: { Key: "error.html" } } }));
    assert.deepEqual((await s3.send(new GetBucketWebsiteCommand({ Bucket: bucket }))).IndexDocument, { Suffix: "index.html" });
    await s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(policy) }));
    assert.deepEqual(JSON.parse((await s3.send(new GetBucketPolicyCommand({ Bucket: bucket }))).Policy!), policy);

    const html = Buffer.from("<!doctype html><main>real website bytes</main>\n");
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "index.html", Body: html, ContentType: "text/html; charset=utf-8" }));
    let website = await fetch(simulator.s3.websiteUrl(bucket));
    assert.equal(website.status, 200); assert.equal(website.headers.get("content-type"), "text/html; charset=utf-8"); assert.deepEqual(Buffer.from(await website.arrayBuffer()), html);

    await s3.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
    const javascript = Buffer.from("console.log('fixture');\n");
    assert.equal((await simulator.s3.putObjectBytesInternal(bucket, "assets/app.js", javascript, { contentType: "text/javascript", metadata: { build: "one" } })).changed, true);
    assert.equal((await simulator.s3.putObjectBytesInternal(bucket, "assets/app.js", javascript, { contentType: "text/javascript", metadata: { build: "one" } })).changed, false);
    assert.equal((await simulator.s3.listObjectVersionsInternal(bucket)).filter(version => version.key === "assets/app.js").length, 1, "identical replay must not create a version");
    assert.equal((await simulator.s3.putObjectBytesInternal(bucket, "assets/app.js", javascript, { contentType: "text/javascript", metadata: { build: "two" } })).changed, true);
    assert.equal((await simulator.s3.deleteObjectInternal(bucket, "assets/app.js")).deleted, true);
    assert.equal((await simulator.s3.deleteObjectInternal(bucket, "assets/app.js")).deleted, false, "delete replay must not add a second marker");

    s3.destroy(); s3 = undefined; await simulator.stop();
    simulator = new StackSim(options); await simulator.start(); s3 = client(simulator);
    assert.deepEqual((await s3.send(new GetBucketTaggingCommand({ Bucket: bucket }))).TagSet, [{ Key: "application", Value: "react" }]);
    assert.equal((await s3.send(new GetBucketWebsiteCommand({ Bucket: bucket }))).ErrorDocument?.Key, "error.html");
    assert.deepEqual(JSON.parse((await s3.send(new GetBucketPolicyCommand({ Bucket: bucket }))).Policy!), policy);
    website = await fetch(simulator.s3.websiteUrl(bucket)); assert.equal(website.status, 200); assert.deepEqual(Buffer.from(await website.arrayBuffer()), html);

    await s3.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
    assert.equal((await fetch(simulator.s3.websiteUrl(bucket))).status, 403);
    await s3.send(new DeleteBucketWebsiteCommand({ Bucket: bucket }));
    await assert.rejects(s3.send(new GetBucketWebsiteCommand({ Bucket: bucket })), (error: any) => error.name === "NoSuchWebsiteConfiguration");
    await s3.send(new DeletePublicAccessBlockCommand({ Bucket: bucket }));
    await assert.rejects(s3.send(new GetPublicAccessBlockCommand({ Bucket: bucket })), (error: any) => error.name === "NoSuchPublicAccessBlockConfiguration");
    await s3.send(new DeleteBucketTaggingCommand({ Bucket: bucket }));
    await assert.rejects(s3.send(new GetBucketTaggingCommand({ Bucket: bucket })), (error: any) => error.name === "NoSuchTagSet");
  } finally {
    s3?.destroy(); await simulator.stop().catch(() => undefined); await rm(dataDir, { recursive: true, force: true });
  }
});
