import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "node:http";
import { test } from "node:test";
import {
  CreateBucketCommand,
  DeleteBucketPolicyCommand,
  DeleteBucketOwnershipControlsCommand,
  GetBucketAbacCommand,
  GetBucketAclCommand,
  GetBucketOwnershipControlsCommand,
  GetBucketPolicyCommand,
  GetBucketPolicyStatusCommand,
  GetBucketRequestPaymentCommand,
  GetObjectAclCommand,
  GetObjectCommand,
  GetPublicAccessBlockCommand,
  ListObjectsV2Command,
  PutBucketAbacCommand,
  PutBucketAclCommand,
  PutBucketOwnershipControlsCommand,
  PutBucketPolicyCommand,
  PutBucketRequestPaymentCommand,
  PutBucketTaggingCommand,
  PutObjectAclCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  DeletePublicAccessBlockCommand as DeleteAccountPublicAccessBlockCommand,
  GetPublicAccessBlockCommand as GetAccountPublicAccessBlockCommand,
  PutPublicAccessBlockCommand as PutAccountPublicAccessBlockCommand,
  S3ControlClient,
} from "@aws-sdk/client-s3-control";
import { StackSim } from "../src/server.js";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { PolicyDocument } from "../src/types.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const publicReadPolicy = (bucket: string) => JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Sid: "PublicRead", Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: `arn:aws:s3:::${bucket}/*` }],
});

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-s3-security-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", authMode: "off" });
  await simulator.start();
  const endpoint = `http://127.0.0.1:${simulator.port}`;
  const s3 = new S3Client({ endpoint, region: "eu-west-1", forcePathStyle: true, credentials });
  const localAgent = new Agent({ lookup: ((_hostname: string, options: { all?: boolean }, callback: (...args: any[]) => void) => options?.all ? callback(null, [{ address: "127.0.0.1", family: 4 }]) : callback(null, "127.0.0.1", 4)) as any });
  const control = new S3ControlClient({ endpoint: `http://localhost:${simulator.port}`, region: "eu-west-1", credentials, requestHandler: new NodeHttpHandler({ httpAgent: localAgent }) });
  return { dataDir, simulator, s3, control, async close() { s3.destroy(); control.destroy(); await simulator.stop(); await rm(dataDir, { recursive: true, force: true }); } };
}

test("S3-05 exposes ownership, ACL, policy status, ABAC, Requester Pays, and account/bucket public access controls", async () => {
  const active = await fixture(); const bucket = "s3-05-security-controls";
  try {
    await active.s3.send(new CreateBucketCommand({ Bucket: bucket }));
    assert.equal((await active.s3.send(new GetBucketOwnershipControlsCommand({ Bucket: bucket }))).OwnershipControls?.Rules?.[0].ObjectOwnership, "BucketOwnerEnforced");
    await assert.rejects(active.s3.send(new PutBucketAclCommand({ Bucket: bucket, ACL: "public-read" })), (error: any) => error.name === "AccessControlListNotSupported");

    await active.s3.send(new PutBucketOwnershipControlsCommand({ Bucket: bucket, OwnershipControls: { Rules: [{ ObjectOwnership: "ObjectWriter" }] } }));
    await active.s3.send(new PutBucketAclCommand({ Bucket: bucket, ACL: "public-read" }));
    const bucketAcl = await active.s3.send(new GetBucketAclCommand({ Bucket: bucket }));
    assert.ok(bucketAcl.Grants?.some(grant => grant.Grantee?.URI?.endsWith("/AllUsers") && grant.Permission === "READ"));
    const grantHeader = await fetch(`http://127.0.0.1:${active.simulator.port}/${bucket}?acl`, {
      method: "PUT",
      headers: { "x-stacksim-service": "s3", "x-amz-grant-read": 'uri="http://acs.amazonaws.com/groups/global/AuthenticatedUsers"' },
    });
    assert.equal(grantHeader.status, 200);
    assert.ok((await active.s3.send(new GetBucketAclCommand({ Bucket: bucket }))).Grants?.some(grant => grant.Grantee?.URI?.endsWith("/AuthenticatedUsers")));

    await active.s3.send(new PutPublicAccessBlockCommand({ Bucket: bucket, PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: false, BlockPublicPolicy: false, RestrictPublicBuckets: false } }));
    await assert.rejects(active.s3.send(new PutBucketAclCommand({ Bucket: bucket, ACL: "public-read-write" })), (error: any) => error.name === "AccessDenied");
    assert.equal((await active.s3.send(new GetPublicAccessBlockCommand({ Bucket: bucket }))).PublicAccessBlockConfiguration?.BlockPublicAcls, true);

    await active.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "private.txt", Body: "private" }));
    await active.s3.send(new PutPublicAccessBlockCommand({ Bucket: bucket, PublicAccessBlockConfiguration: { BlockPublicAcls: false, IgnorePublicAcls: true, BlockPublicPolicy: false, RestrictPublicBuckets: false } }));
    await active.s3.send(new PutObjectAclCommand({ Bucket: bucket, Key: "private.txt", ACL: "public-read" }));
    assert.ok((await active.s3.send(new GetObjectAclCommand({ Bucket: bucket, Key: "private.txt" }))).Grants?.some(grant => grant.Grantee?.URI?.endsWith("/AllUsers")));
    const owner = (await active.s3.send(new GetObjectAclCommand({ Bucket: bucket, Key: "private.txt" }))).Owner!;
    const aclXml = `<AccessControlPolicy xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>${owner.ID}</ID></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>${owner.ID}</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Group"><URI>http://acs.amazonaws.com/groups/global/AllUsers</URI></Grantee><Permission>READ</Permission></Grant></AccessControlList></AccessControlPolicy>`;
    const xmlAcl = await fetch(`http://127.0.0.1:${active.simulator.port}/${bucket}/private.txt?acl`, {
      method: "PUT",
      headers: { "x-stacksim-service": "s3", "content-type": "application/xml" },
      body: aclXml,
    });
    assert.equal(xmlAcl.status, 200);
    assert.ok((await active.s3.send(new GetObjectAclCommand({ Bucket: bucket, Key: "private.txt" }))).Grants?.some(grant => grant.Grantee?.URI?.endsWith("/AllUsers")));

    await active.s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: publicReadPolicy(bucket) }));
    assert.equal((await active.s3.send(new GetBucketPolicyStatusCommand({ Bucket: bucket }))).PolicyStatus?.IsPublic, true);
    await active.s3.send(new PutPublicAccessBlockCommand({ Bucket: bucket, PublicAccessBlockConfiguration: { BlockPublicAcls: false, IgnorePublicAcls: false, BlockPublicPolicy: true, RestrictPublicBuckets: false } }));
    await assert.rejects(active.s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: publicReadPolicy(bucket) })), (error: any) => error.name === "AccessDenied");
    await assert.rejects(active.s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::000000000000:role/missing" }, Action: "s3:GetObject", Resource: `arn:aws:s3:::${bucket}/*` }] }) })), (error: any) => error.name === "InvalidPrincipal");
    await assert.rejects(active.s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Sid: "x".repeat(21_000), Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: `arn:aws:s3:::${bucket}/*` }] }) })), (error: any) => error.name === "PolicyTooLarge");

    await active.s3.send(new PutBucketAbacCommand({ Bucket: bucket, AbacStatus: { Status: "Enabled" } }));
    assert.equal((await active.s3.send(new GetBucketAbacCommand({ Bucket: bucket }))).AbacStatus?.Status, "Enabled");
    await active.s3.send(new PutBucketRequestPaymentCommand({ Bucket: bucket, RequestPaymentConfiguration: { Payer: "Requester" } }));
    assert.equal((await active.s3.send(new GetBucketRequestPaymentCommand({ Bucket: bucket }))).Payer, "Requester");

    await assert.rejects(active.control.send(new GetAccountPublicAccessBlockCommand({ AccountId: "000000000000" })), (error: any) => error.name === "NoSuchPublicAccessBlockConfiguration");
    await active.control.send(new PutAccountPublicAccessBlockCommand({ AccountId: "000000000000", PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } }));
    const accountBlock = await active.control.send(new GetAccountPublicAccessBlockCommand({ AccountId: "000000000000" }));
    assert.deepEqual(accountBlock.PublicAccessBlockConfiguration, { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true });
    await active.control.send(new DeleteAccountPublicAccessBlockCommand({ AccountId: "000000000000" }));
    await assert.rejects(active.control.send(new GetAccountPublicAccessBlockCommand({ AccountId: "000000000000" })), (error: any) => error.name === "NoSuchPublicAccessBlockConfiguration");

    await active.s3.send(new DeleteBucketOwnershipControlsCommand({ Bucket: bucket }));
    await assert.rejects(active.s3.send(new GetBucketOwnershipControlsCommand({ Bucket: bucket })), (error: any) => error.name === "OwnershipControlsNotFoundError");
  } finally { await active.close(); }
});

test("S3-05 access state survives restart", async () => {
  const active = await fixture(); const bucket = "s3-05-restart";
  try {
    await active.s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await active.s3.send(new PutBucketOwnershipControlsCommand({ Bucket: bucket, OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerPreferred" }] } }));
    await active.s3.send(new PutBucketAbacCommand({ Bucket: bucket, AbacStatus: { Status: "Enabled" } }));
    await active.s3.send(new PutBucketRequestPaymentCommand({ Bucket: bucket, RequestPaymentConfiguration: { Payer: "Requester" } }));
    await active.s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::000000000000:root" }, Action: "s3:GetObject", Resource: `arn:aws:s3:::${bucket}/*` }] }) }));
    await active.control.send(new PutAccountPublicAccessBlockCommand({ AccountId: "000000000000", PublicAccessBlockConfiguration: { BlockPublicAcls: false, IgnorePublicAcls: false, BlockPublicPolicy: false, RestrictPublicBuckets: true } }));
    active.s3.destroy(); active.control.destroy(); await active.simulator.stop();
    const restarted = new StackSim({ port: 0, invokePort: 0, dataDir: active.dataDir, region: "eu-west-1", authMode: "off" }); await restarted.start();
    const s3 = new S3Client({ endpoint: `http://127.0.0.1:${restarted.port}`, region: "eu-west-1", forcePathStyle: true, credentials });
    try {
      assert.equal((await s3.send(new GetBucketOwnershipControlsCommand({ Bucket: bucket }))).OwnershipControls?.Rules?.[0].ObjectOwnership, "BucketOwnerPreferred");
      assert.equal((await s3.send(new GetBucketAbacCommand({ Bucket: bucket }))).AbacStatus?.Status, "Enabled");
      assert.equal((await s3.send(new GetBucketRequestPaymentCommand({ Bucket: bucket }))).Payer, "Requester");
      assert.match((await s3.send(new GetBucketPolicyCommand({ Bucket: bucket }))).Policy!, /000000000000:root/);
      assert.equal(restarted.store.ensureAccount().s3PublicAccessBlock?.restrictPublicBuckets, true);
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "owner.txt", Body: "owner" }));
      assert.equal(Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "owner.txt" }))).Body!.transformToByteArray()).toString(), "owner");
    } finally { s3.destroy(); await restarted.stop(); }
  } finally { await rm(active.dataDir, { recursive: true, force: true }); }
});

test("S3-05 schema v55 migration adds secure bucket defaults without inventing account public-access state", async () => {
  const active = await fixture(); const bucket = "s3-05-migration";
  let restarted: StackSim | undefined;
  try {
    await active.s3.send(new CreateBucketCommand({ Bucket: bucket }));
    active.s3.destroy(); active.control.destroy(); await active.simulator.stop();
    const stateFile = join(active.dataDir, "state.json");
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    state.schemaVersion = 54;
    const oldBucket = state.accounts["000000000000"].regions["eu-west-1"].s3Buckets[bucket];
    delete oldBucket.objectOwnership; delete oldBucket.acl; delete oldBucket.requestPayment; delete oldBucket.abacStatus;
    delete state.accounts["000000000000"].s3PublicAccessBlock;
    await writeFile(stateFile, JSON.stringify(state));

    restarted = new StackSim({ port: 0, invokePort: 0, dataDir: active.dataDir, region: "eu-west-1", authMode: "off" }); await restarted.start();
    const migrated = restarted.store.regionState("eu-west-1").s3Buckets[bucket];
    assert.equal(restarted.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(migrated.objectOwnership, "BucketOwnerEnforced");
    assert.equal(migrated.requestPayment, "BucketOwner");
    assert.equal(migrated.abacStatus, "Disabled");
    assert.equal(migrated.acl?.grants.length, 1);
    assert.equal(restarted.store.ensureAccount().s3PublicAccessBlock, undefined);
  } finally {
    await restarted?.stop().catch(() => undefined);
    await rm(active.dataDir, { recursive: true, force: true });
  }
});

test("S3-05 enforce mode combines identity, bucket policy, conditions, session policy, and explicit deny", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-s3-security-auth-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", authMode: "enforce", cdkBootstrap: true });
  await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; const clients: Array<{ destroy(): void }> = [];
  const root = new S3Client({ endpoint, region: "eu-west-1", forcePathStyle: true, credentials }); clients.push(root);
  const iam = new IAMClient({ endpoint, region: "eu-west-1", credentials }); clients.push(iam);
  const sts = new STSClient({ endpoint, region: "eu-west-1", credentials }); clients.push(sts);
  const bucket = "s3-05-enforced-policy"; const roleArn = "arn:aws:iam::000000000000:role/s3-reader";
  try {
    await root.send(new CreateBucketCommand({ Bucket: bucket }));
    await root.send(new PutObjectCommand({ Bucket: bucket, Key: "allowed/item.txt", Body: "allowed" }));
    await root.send(new PutObjectCommand({ Bucket: bucket, Key: "denied/item.txt", Body: "denied" }));
    await root.send(new PutObjectCommand({ Bucket: bucket, Key: "tagged/public.txt", Body: "tagged", Tagging: "classification=public" }));
    await root.send(new PutObjectCommand({ Bucket: bucket, Key: "tagged/private.txt", Body: "private", Tagging: "classification=private" }));
    await iam.send(new CreateRoleCommand({ RoleName: "s3-reader", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::000000000000:root" }, Action: "sts:AssumeRole" }] }) }));
    await iam.send(new PutRolePolicyCommand({ RoleName: "s3-reader", PolicyName: "baseline", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [
      { Effect: "Allow", Action: "s3:GetObject", Resource: `arn:aws:s3:::${bucket}/allowed/*` },
      { Effect: "Allow", Action: "s3:GetObject", Resource: `arn:aws:s3:::${bucket}/tagged/*`, Condition: { StringEquals: { "s3:ExistingObjectTag/classification": "public" } } },
      { Effect: "Allow", Action: "s3:ListBucket", Resource: `arn:aws:s3:::${bucket}`, Condition: { StringLike: { "s3:prefix": "allowed/*" } } },
      { Effect: "Allow", Action: "s3:GetBucketAcl", Resource: `arn:aws:s3:::${bucket}` },
    ] }) }));
    await root.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        { Sid: "ReadAllowed", Effect: "Allow", Principal: { AWS: roleArn }, Action: "s3:GetObject", Resource: `arn:aws:s3:::${bucket}/allowed/*` },
        { Sid: "ReadTagged", Effect: "Allow", Principal: { AWS: roleArn }, Action: "s3:GetObject", Resource: `arn:aws:s3:::${bucket}/tagged/*`, Condition: { StringEquals: { "s3:ExistingObjectTag/classification": "public" } } },
        { Sid: "ListPrefix", Effect: "Allow", Principal: { AWS: roleArn }, Action: "s3:ListBucket", Resource: `arn:aws:s3:::${bucket}`, Condition: { StringLike: { "s3:prefix": "allowed/*" } } },
        { Sid: "DenySecret", Effect: "Deny", Principal: { AWS: roleArn }, Action: "s3:GetObject", Resource: `arn:aws:s3:::${bucket}/denied/*` },
      ],
    }) }));
    const assumed = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: "reader" }));
    const readerCredentials = { accessKeyId: assumed.Credentials!.AccessKeyId!, secretAccessKey: assumed.Credentials!.SecretAccessKey!, sessionToken: assumed.Credentials!.SessionToken! };
    const reader = new S3Client({ endpoint, region: "eu-west-1", forcePathStyle: true, credentials: readerCredentials }); clients.push(reader);
    assert.equal(Buffer.from(await (await reader.send(new GetObjectCommand({ Bucket: bucket, Key: "allowed/item.txt" }))).Body!.transformToByteArray()).toString(), "allowed");
    assert.equal((await reader.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "allowed/" }))).KeyCount, 1);
    await assert.rejects(reader.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "denied/" })), (error: any) => error.name === "AccessDeniedException");
    assert.equal(Buffer.from(await (await reader.send(new GetObjectCommand({ Bucket: bucket, Key: "tagged/public.txt" }))).Body!.transformToByteArray()).toString(), "tagged");
    await assert.rejects(reader.send(new GetObjectCommand({ Bucket: bucket, Key: "tagged/private.txt" })), (error: any) => error.name === "AccessDeniedException");
    await assert.rejects(reader.send(new GetObjectCommand({ Bucket: bucket, Key: "denied/item.txt" })), (error: any) => error.name === "AccessDeniedException");

    const boundaryArn = "arn:aws:iam::000000000000:policy/s3-reader-boundary";
    const accountIam = simulator.store.ensureAccount().iam;
    accountIam.policies[boundaryArn] = {
      policyName: "s3-reader-boundary", policyId: "ANPABOUNDARY", arn: boundaryArn, path: "/", createDate: Date.now(), updateDate: Date.now(), tags: {},
      defaultVersionId: "v1", awsManaged: false,
      versions: { v1: { versionId: "v1", createDate: Date.now(), isDefaultVersion: true, document: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:ListBucket", Resource: `arn:aws:s3:::${bucket}` }] } } },
    };
    accountIam.roles["s3-reader"].permissionsBoundaryArn = boundaryArn; await simulator.store.save();
    await assert.rejects(reader.send(new GetObjectCommand({ Bucket: bucket, Key: "allowed/item.txt" })), (error: any) => error.name === "AccessDeniedException" && /Permissions boundary/.test(error.message));
    accountIam.policies[boundaryArn].versions.v1.document = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["s3:GetObject", "s3:ListBucket", "s3:GetBucketAcl"], Resource: "*" }] }; await simulator.store.save();
    assert.equal(Buffer.from(await (await reader.send(new GetObjectCommand({ Bucket: bucket, Key: "allowed/item.txt" }))).Body!.transformToByteArray()).toString(), "allowed");

    const limited = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: "limited", Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: `arn:aws:s3:::${bucket}/allowed/*` }] }) }));
    const limitedClient = new S3Client({ endpoint, region: "eu-west-1", forcePathStyle: true, credentials: { accessKeyId: limited.Credentials!.AccessKeyId!, secretAccessKey: limited.Credentials!.SecretAccessKey!, sessionToken: limited.Credentials!.SessionToken! } }); clients.push(limitedClient);
    await assert.rejects(limitedClient.send(new GetBucketAclCommand({ Bucket: bucket })), (error: any) => error.name === "AccessDeniedException" && /Session policy/.test(error.message));
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop(); await rm(dataDir, { recursive: true, force: true });
  }
});

test("S3-05 enforces anonymous, presigned, ACL, Requester Pays, public-access-block, and root-recovery behavior", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-s3-security-public-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", authMode: "enforce", cdkBootstrap: true });
  await simulator.start();
  const endpoint = `http://127.0.0.1:${simulator.port}`;
  const root = new S3Client({ endpoint, region: "eu-west-1", forcePathStyle: true, credentials });
  const localAgent = new Agent({ lookup: ((_hostname: string, options: { all?: boolean }, callback: (...args: any[]) => void) => options?.all ? callback(null, [{ address: "127.0.0.1", family: 4 }]) : callback(null, "127.0.0.1", 4)) as any });
  const control = new S3ControlClient({ endpoint: `http://localhost:${simulator.port}`, region: "eu-west-1", credentials, requestHandler: new NodeHttpHandler({ httpAgent: localAgent }) });
  const bucket = "s3-05-public-access";
  const anonymousUrl = `${endpoint}/${bucket}/public.txt`;
  const anonymousHeaders = { "x-stacksim-service": "s3" };
  try {
    await root.send(new CreateBucketCommand({ Bucket: bucket }));
    await root.send(new PutObjectCommand({ Bucket: bucket, Key: "public.txt", Body: "public" }));
    await root.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: publicReadPolicy(bucket) }));
    let response = await fetch(anonymousUrl, { headers: anonymousHeaders });
    assert.equal(response.status, 200); assert.equal(await response.text(), "public");

    const presigned = await getSignedUrl(root, new GetObjectCommand({ Bucket: bucket, Key: "public.txt" }), { expiresIn: 60 });
    response = await fetch(presigned); assert.equal(response.status, 200); assert.equal(await response.text(), "public");

    await control.send(new PutAccountPublicAccessBlockCommand({ AccountId: "000000000000", PublicAccessBlockConfiguration: { BlockPublicAcls: false, IgnorePublicAcls: false, BlockPublicPolicy: false, RestrictPublicBuckets: true } }));
    assert.equal((await fetch(anonymousUrl, { headers: anonymousHeaders })).status, 403, "account RestrictPublicBuckets must suppress public policy access");
    await control.send(new PutAccountPublicAccessBlockCommand({ AccountId: "000000000000", PublicAccessBlockConfiguration: { BlockPublicAcls: false, IgnorePublicAcls: false, BlockPublicPolicy: false, RestrictPublicBuckets: false } }));

    await root.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
    await root.send(new PutBucketOwnershipControlsCommand({ Bucket: bucket, OwnershipControls: { Rules: [{ ObjectOwnership: "ObjectWriter" }] } }));
    await root.send(new PutObjectAclCommand({ Bucket: bucket, Key: "public.txt", ACL: "public-read" }));
    response = await fetch(anonymousUrl, { headers: anonymousHeaders }); assert.equal(response.status, 200); assert.equal(await response.text(), "public");
    await root.send(new PutPublicAccessBlockCommand({ Bucket: bucket, PublicAccessBlockConfiguration: { BlockPublicAcls: false, IgnorePublicAcls: true, BlockPublicPolicy: false, RestrictPublicBuckets: false } }));
    assert.equal((await fetch(anonymousUrl, { headers: anonymousHeaders })).status, 403, "IgnorePublicAcls must suppress the stored public grant");
    await root.send(new PutPublicAccessBlockCommand({ Bucket: bucket, PublicAccessBlockConfiguration: { BlockPublicAcls: false, IgnorePublicAcls: false, BlockPublicPolicy: false, RestrictPublicBuckets: false } }));

    await root.send(new PutBucketRequestPaymentCommand({ Bucket: bucket, RequestPaymentConfiguration: { Payer: "Requester" } }));
    assert.equal((await fetch(anonymousUrl, { headers: anonymousHeaders })).status, 403);
    response = await fetch(anonymousUrl, { headers: { ...anonymousHeaders, "x-amz-request-payer": "requester" } });
    assert.equal(response.status, 200); assert.equal(response.headers.get("x-amz-request-charged"), "requester");

    await control.send(new PutAccountPublicAccessBlockCommand({ AccountId: "000000000000", PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: false, BlockPublicPolicy: true, RestrictPublicBuckets: false } }));
    await assert.rejects(root.send(new PutObjectCommand({ Bucket: bucket, Key: "blocked-acl.txt", Body: "blocked", ACL: "public-read" })), (error: any) => error.name === "AccessDenied");
    await assert.rejects(root.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: publicReadPolicy(bucket) })), (error: any) => error.name === "AccessDenied");
    await control.send(new DeleteAccountPublicAccessBlockCommand({ AccountId: "000000000000" }));

    const lockout = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Deny", Principal: { AWS: "arn:aws:iam::000000000000:root" }, Action: "s3:PutBucketPolicy", Resource: `arn:aws:s3:::${bucket}` }] });
    await assert.rejects(root.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: lockout })), (error: any) => error.name === "AccessDenied");
    await root.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: lockout, ConfirmRemoveSelfBucketAccess: true }));
    await root.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
  } finally {
    root.destroy(); control.destroy(); await simulator.stop(); await rm(dataDir, { recursive: true, force: true });
  }
});

test("S3-05 requires cross-account dual allows and evaluates prefix, object-tag, bucket-tag ABAC, and Requester Pays", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-s3-security-cross-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", authMode: "enforce", cdkBootstrap: true });
  await simulator.start();
  const endpoint = `http://127.0.0.1:${simulator.port}`;
  const owner = new S3Client({ endpoint, region: "eu-west-1", forcePathStyle: true, credentials });
  const clients: Array<{ destroy(): void }> = [owner];
  const bucket = "s3-05-cross-account";
  const externalAccount = "111122223333"; const roleName = "ExternalS3Reader"; const roleArn = `arn:aws:iam::${externalAccount}:role/${roleName}`;
  const accessKeyId = "ASIAEXTERNALS3READER"; const secretAccessKey = "external-secret"; const sessionToken = "external-session";
  try {
    await owner.send(new CreateBucketCommand({ Bucket: bucket }));
    await owner.send(new PutObjectCommand({ Bucket: bucket, Key: "allowed/public.txt", Body: "public", Tagging: "classification=public" }));
    await owner.send(new PutObjectCommand({ Bucket: bucket, Key: "allowed/private.txt", Body: "private", Tagging: "classification=private" }));
    await owner.send(new PutBucketTaggingCommand({ Bucket: bucket, Tagging: { TagSet: [{ Key: "project", Value: "blue" }] } }));
    await owner.send(new PutBucketAbacCommand({ Bucket: bucket, AbacStatus: { Status: "Enabled" } }));

    const externalIam = simulator.store.ensureAccount(externalAccount).iam;
    const identityDocument = (): PolicyDocument => ({ Version: "2012-10-17", Statement: [
      { Effect: "Allow", Action: "s3:GetObject", Resource: `arn:aws:s3:::${bucket}/allowed/*`, Condition: { StringEquals: { "s3:ExistingObjectTag/classification": "public" } } },
      { Effect: "Allow", Action: "s3:ListBucket", Resource: `arn:aws:s3:::${bucket}`, Condition: { StringLike: { "s3:prefix": "allowed/*" } } },
      { Effect: "Allow", Action: "s3:GetBucketAcl", Resource: `arn:aws:s3:::${bucket}`, Condition: { StringEquals: { "aws:ResourceTag/project": "blue" } } },
    ] });
    externalIam.roles[roleName] = {
      roleName, roleId: "AROAEXTERNALS3READER", arn: roleArn, path: "/", createDate: Date.now(), maxSessionDuration: 3600,
      assumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${externalAccount}:root` }, Action: "sts:AssumeRole" }] },
      tags: {}, attachedPolicyArns: [], inlinePolicies: { s3: identityDocument() },
    };
    const credentialId = "external-s3-reader-session";
    await simulator.store.credentialStore!.put({ credentialId, type: "sts-session", accountId: externalAccount, ownerId: "AROAX:developer", accessKeyId }, { secretAccessKey, sessionToken });
    externalIam.sessions[accessKeyId] = { accessKeyId, credentialId, principalArn: `arn:aws:sts::${externalAccount}:assumed-role/${roleName}/developer`, principalId: "AROAX:developer", roleArn, roleName, sessionName: "developer", expiration: Date.now() + 60_000, sessionTags: {} };
    await simulator.store.save();
    const resourcePolicy = () => JSON.stringify({ Version: "2012-10-17", Statement: [
      { Effect: "Allow", Principal: { AWS: roleArn }, Action: "s3:GetObject", Resource: `arn:aws:s3:::${bucket}/allowed/*`, Condition: { StringEquals: { "s3:ExistingObjectTag/classification": "public" } } },
      { Effect: "Allow", Principal: { AWS: roleArn }, Action: "s3:ListBucket", Resource: `arn:aws:s3:::${bucket}`, Condition: { StringLike: { "s3:prefix": "allowed/*" } } },
      { Effect: "Allow", Principal: { AWS: roleArn }, Action: "s3:GetBucketAcl", Resource: `arn:aws:s3:::${bucket}` },
    ] });
    await owner.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: resourcePolicy() }));

    const external = new S3Client({ endpoint, region: "eu-west-1", forcePathStyle: true, credentials: { accessKeyId, secretAccessKey, sessionToken } }); clients.push(external);
    assert.equal(Buffer.from(await (await external.send(new GetObjectCommand({ Bucket: bucket, Key: "allowed/public.txt" }))).Body!.transformToByteArray()).toString(), "public");
    await assert.rejects(external.send(new GetObjectCommand({ Bucket: bucket, Key: "allowed/private.txt" })), (error: any) => error.name === "AccessDeniedException");
    assert.equal((await external.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "allowed/" }))).KeyCount, 2);
    await assert.rejects(external.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "other/" })), (error: any) => error.name === "AccessDeniedException");
    await external.send(new GetBucketAclCommand({ Bucket: bucket }));

    externalIam.roles[roleName].inlinePolicies.s3 = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:ListBucket", Resource: `arn:aws:s3:::${bucket}` }] }; await simulator.store.save();
    await assert.rejects(external.send(new GetObjectCommand({ Bucket: bucket, Key: "allowed/public.txt" })), (error: any) => error.name === "AccessDeniedException", "resource policy alone must not authorize cross-account access");
    externalIam.roles[roleName].inlinePolicies.s3 = identityDocument(); await simulator.store.save();
    await owner.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: roleArn }, Action: "s3:ListBucket", Resource: `arn:aws:s3:::${bucket}` }] }) }));
    await assert.rejects(external.send(new GetObjectCommand({ Bucket: bucket, Key: "allowed/public.txt" })), (error: any) => error.name === "AccessDeniedException", "identity policy alone must not authorize cross-account access");
    await owner.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: resourcePolicy() }));

    await owner.send(new PutBucketRequestPaymentCommand({ Bucket: bucket, RequestPaymentConfiguration: { Payer: "Requester" } }));
    await assert.rejects(external.send(new GetObjectCommand({ Bucket: bucket, Key: "allowed/public.txt" })), (error: any) => error.name === "AccessDenied");
    const charged = await external.send(new GetObjectCommand({ Bucket: bucket, Key: "allowed/public.txt", RequestPayer: "requester" }));
    assert.equal(charged.RequestCharged, "requester");

    await owner.send(new PutBucketAbacCommand({ Bucket: bucket, AbacStatus: { Status: "Disabled" } }));
    await assert.rejects(external.send(new GetBucketAclCommand({ Bucket: bucket })), (error: any) => error.name === "AccessDeniedException", "disabled bucket ABAC must omit bucket resource tags");
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop(); await rm(dataDir, { recursive: true, force: true });
  }
});
