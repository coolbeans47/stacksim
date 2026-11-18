import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { test } from "node:test";
import * as Iam from "@aws-sdk/client-iam";
import * as S3 from "@aws-sdk/client-s3";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { StackSim } from "../src/server.js";

const region = "eu-west-1", credentials = { accessKeyId: "admin", secretAccessKey: "password" };
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> { for (let i = 0; i < 200; i++) { const value = await read(); if (check(value)) return value; await delay(10); } throw new Error("Snapshot operation timed out"); }
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "stacksim-snapshot-")), sim = new StackSim({ dataDir: root, port: 0, invokePort: 0, authMode: "enforce", cdkBootstrap: false }); await sim.start();
  const config = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }, iam = new Iam.IAMClient(config), s3 = new S3.S3Client({ ...config, forcePathStyle: true });
  const clients: Client[] = [];
  const search = async (domainName: string, creds = credentials, advanced = false) => {
    await sim.opensearch.execute("CreateDomain", { DomainName: domainName, EncryptionAtRestOptions: { Enabled: true }, ...(advanced ? { AdvancedSecurityOptions: { Enabled: true, MasterUserOptions: { MasterUserARN: `arn:aws:iam::${sim.store.accountId}:user/admin` } }, NodeToNodeEncryptionOptions: { Enabled: true } } : {}) }, region);
    const domain = await until(async () => sim.opensearch.domain(region, domainName), domain => domain.state === "active"), ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath);
    const client = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => creds }) }); clients.push(client); return { client, domain };
  };
  const role = async (name = "SnapshotRole") => (await iam.send(new Iam.CreateRoleCommand({ RoleName: name, AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "es.amazonaws.com" }, Action: "sts:AssumeRole", Condition: { StringEquals: { "aws:SourceAccount": sim.store.accountId }, ArnLike: { "aws:SourceArn": `arn:aws:es:${region}:${sim.store.accountId}:domain/*` } } }] }) }))).Role!;
  return { root, sim, iam, s3, search, role, async close() { await Promise.all(clients.map(client => client.close())); iam.destroy(); s3.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); } };
}

test("official snapshot client verifies S3 repository, takes backups and restores into another domain", { timeout: 60000 }, async () => {
  const env = await setup();
  try {
    const { client, domain } = await env.search("snapshot-source"), target = await env.search("snapshot-target"), role = await env.role();
    const bucket = "search-backups", prefix = "daily", settings: any = { bucket, base_path: prefix, region, role_arn: role.Arn! };
    await env.s3.send(new S3.CreateBucketCommand({ Bucket: bucket }));
    await env.iam.send(new Iam.PutRolePolicyCommand({ RoleName: role.RoleName!, PolicyName: "objects", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:ListBucket", Resource: `arn:aws:s3:::${bucket}` }, { Effect: "Allow", Action: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], Resource: `arn:aws:s3:::${bucket}/${prefix}/*` }] }) }));
    assert.equal((await client.snapshot.createRepository({ repository: "backups", body: { type: "s3", settings } })).body.acknowledged, true);
    assert.equal(Object.keys((await client.snapshot.verifyRepository({ repository: "backups" })).body.nodes).length, 1);
    assert.equal((await env.s3.send(new S3.ListObjectsV2Command({ Bucket: bucket }))).KeyCount, 0);
    await assert.rejects(target.client.snapshot.createRepository({ repository: "duplicate", body: { type: "s3", settings } }), (error: any) => error.statusCode === 409);
    await client.indices.create({ index: "products", body: { settings: { refresh_interval: "-1" }, mappings: { properties: { price: { type: "integer" } } }, aliases: { shop: { is_write_index: true } } } });
    await client.index({ index: "products", id: "one", body: { title: "Red shoes", price: 12 } });
    const created = await client.snapshot.create({ repository: "backups", snapshot: "first", wait_for_completion: true, body: { indices: "products" } }); assert.equal(created.body.snapshot?.state, "SUCCESS");
    await client.index({ index: "products", id: "later", body: { title: "Later", price: 99 } });
    const objects = (await env.s3.send(new S3.ListObjectsV2Command({ Bucket: bucket }))).Contents!; assert.equal(objects.length, 1); assert.equal(objects[0].Key, "daily/stacksim-snapshots-v1/first.json.gz");
    const object = await env.s3.send(new S3.GetObjectCommand({ Bucket: bucket, Key: objects[0].Key })), bytes = Buffer.from(await object.Body!.transformToByteArray()), portable = JSON.parse(gunzipSync(bytes).toString());
    assert.equal(portable.data.format, "stacksim-search-snapshot-v1"); assert.equal(portable.data.indexes[0].documents.length, 1); assert.equal(portable.snapshot.uuid, created.body.snapshot?.uuid);
    assert.equal((await client.snapshot.get({ repository: "backups", snapshot: "_all" })).body.snapshots.length, 1);
    assert.equal((await client.snapshot.status({ repository: "backups", snapshot: "first" })).body.snapshots[0].indices?.products.shards?.["0"].stage, "DONE");
    assert.deepEqual((await client.snapshot.status({})).body.snapshots, []);
    await target.client.snapshot.createRepository({ repository: "reader", body: { type: "s3", settings: { ...settings, readonly: true } as any } });
    assert.equal((await target.client.snapshot.status({ repository: "reader", snapshot: "first" })).body.snapshots[0].shards_stats?.done, 1);
    assert.equal((await target.client.snapshot.restore({ repository: "reader", snapshot: "first", wait_for_completion: true, body: { rename_pattern: "(.+)", rename_replacement: "restored-$1" } })).body.snapshot?.shards?.failed, 0);
    const result = await target.client.search({ index: "shop", body: { query: { match_all: {} } } }); assert.equal((result.body.hits.total as any).value, 1); assert.equal(result.body.hits.hits[0]._source.price, 12);
    await assert.rejects(target.client.snapshot.restore({ repository: "reader", snapshot: "first", wait_for_completion: true, body: { rename_pattern: "(.+)", rename_replacement: "restored-$1" } }), /existing index/);
    await assert.rejects(target.client.snapshot.delete({ repository: "reader", snapshot: "first" }), (error: any) => error.statusCode === 403);
    await client.snapshot.deleteRepository({ repository: "backups" }); assert.equal((await env.s3.send(new S3.ListObjectsV2Command({ Bucket: bucket }))).KeyCount, 1);
    await client.snapshot.createRepository({ repository: "backups", body: { type: "s3", settings } });
    await client.snapshot.delete({ repository: "backups", snapshot: "first" }); assert.equal((await env.s3.send(new S3.ListObjectsV2Command({ Bucket: bucket }))).KeyCount, 0);
    assert.equal(domain.state, "active");
  } finally { await env.close(); }
});

test("snapshot role, bucket policies, PassRole and FGAC deny access; corrupt or archived objects cannot restore", { timeout: 60000 }, async () => {
  const env = await setup();
  try {
    const { client, domain } = await env.search("secured-snapshots", credentials, true), role = await env.role(), bucket = "secure-backups", settings: any = { bucket, region, role_arn: role.Arn! };
    await env.s3.send(new S3.CreateBucketCommand({ Bucket: bucket }));
    await assert.rejects(client.snapshot.createRepository({ repository: "backups", body: { type: "s3", settings } }), (error: any) => error.statusCode === 403);
    await env.iam.send(new Iam.PutRolePolicyCommand({ RoleName: role.RoleName!, PolicyName: "objects", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:*", Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`] }] }) }));
    await client.snapshot.createRepository({ repository: "backups", body: { type: "s3", settings } });
    await client.index({ index: "records", id: "one", body: { title: "private" } });
    await env.iam.send(new Iam.CreateUserCommand({ UserName: "snapshot-reader" })); const access = (await env.iam.send(new Iam.CreateAccessKeyCommand({ UserName: "snapshot-reader" }))).AccessKey!;
    await env.iam.send(new Iam.PutUserPolicyCommand({ UserName: "snapshot-reader", PolicyName: "http", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "es:ESHttp*", Resource: `${domain.arn}/*` }] }) }));
    const ca = await readFile(env.sim.opensearch.diagnostics(region).caCertificatePath), reader = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => ({ accessKeyId: access.AccessKeyId!, secretAccessKey: access.SecretAccessKey! }) }) });
    try {
      await assert.rejects(reader.snapshot.getRepository({ repository: "backups" }), (error: any) => error.statusCode === 403);
      await client.transport.request({ method: "PUT", path: "/_plugins/_security/api/rolesmapping/manage_snapshots", body: { users: [`arn:aws:iam::${env.sim.store.accountId}:user/snapshot-reader`] } });
      await assert.rejects(reader.snapshot.createRepository({ repository: "reader", body: { type: "s3", settings: { ...settings, readonly: true } as any } }), /PassRole/);
      await client.transport.request({ method: "PUT", path: "/_plugins/_security/api/internalusers/operator", body: { password: "Snapshot-password1!", opendistro_security_roles: ["manage_snapshots"] } });
      await env.sim.opensearch.execute("UpdateDomainConfig", { DomainName: domain.name, AccessPolicies: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "es:ESHttp*", Resource: `${domain.arn}/*` }] }) }, region);
      await client.transport.request({ method: "PUT", path: "/_plugins/_security/api/rolesmapping/all_access", body: { users: [`arn:aws:iam::${env.sim.store.accountId}:user/admin`] } });
      await env.sim.opensearch.execute("UpdateDomainConfig", { DomainName: domain.name, AdvancedSecurityOptions: { Enabled: true, InternalUserDatabaseEnabled: true, MasterUserOptions: { MasterUserName: "internal-master", MasterUserPassword: "Internal-password1!" } } }, region);
      await until(async () => domain, value => value.config.AdvancedSecurityOptions.InternalUserDatabaseEnabled && value.changes?.at(-1)?.state === "COMPLETED");
      const basic = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca }, auth: { username: "operator", password: "Snapshot-password1!" } });
      try { assert.ok((await basic.snapshot.getRepository({ repository: "backups" })).body.backups); await assert.rejects(basic.snapshot.createRepository({ repository: "basic", body: { type: "s3", settings } }), /IAM identity/); } finally { await basic.close(); }
      const denied = { Version: "2012-10-17", Statement: [{ Effect: "Deny", Principal: { AWS: role.Arn }, Action: "s3:PutObject", Resource: `arn:aws:s3:::${bucket}/*` }] };
      await env.s3.send(new S3.PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(denied) }));
      const failed = await reader.snapshot.create({ repository: "backups", snapshot: "denied", wait_for_completion: true }); assert.equal(failed.body.snapshot?.state, "FAILED"); assert.ok(failed.body.snapshot?.failures?.length);
      await env.s3.send(new S3.DeleteBucketPolicyCommand({ Bucket: bucket }));
      await client.snapshot.createRepository({ repository: "backups", body: { type: "s3", settings: { ...settings, base_path: "moved" } } });
      await assert.rejects(client.snapshot.get({ repository: "backups", snapshot: "denied" }), (error: any) => error.statusCode === 404);
      assert.equal((await reader.snapshot.create({ repository: "backups", snapshot: "denied", wait_for_completion: true })).body.snapshot?.state, "SUCCESS");
      await client.snapshot.delete({ repository: "backups", snapshot: "denied" });
      await client.snapshot.createRepository({ repository: "backups", body: { type: "s3", settings } });
      await client.snapshot.delete({ repository: "backups", snapshot: "denied" });
      assert.equal((await reader.snapshot.create({ repository: "backups", snapshot: "good", wait_for_completion: true })).body.snapshot?.state, "SUCCESS");
    } finally { await reader.close(); }
    const key = "stacksim-snapshots-v1/good.json.gz", original = Buffer.from(await (await env.s3.send(new S3.GetObjectCommand({ Bucket: bucket, Key: key }))).Body!.transformToByteArray());
    const document = JSON.parse(gunzipSync(original).toString()); assert.ok(!JSON.stringify(document).includes("Snapshot-password1")); assert.deepEqual(Object.keys(document.data).sort(), ["format", "indexes", "templates"]);
    await env.s3.send(new S3.PutObjectCommand({ Bucket: bucket, Key: key, Body: "corrupt" }));
    await assert.rejects(client.snapshot.restore({ repository: "backups", snapshot: "good", wait_for_completion: true, body: { rename_pattern: "(.+)", rename_replacement: "bad-$1" } }), /corrupt/); assert.equal((await client.indices.exists({ index: "bad-records" })).body, false);
    const customerKey = Buffer.alloc(32, 7);
    await env.s3.send(new S3.PutObjectCommand({ Bucket: bucket, Key: key, Body: original, SSECustomerAlgorithm: "AES256", SSECustomerKey: customerKey.toString("base64"), SSECustomerKeyMD5: createHash("md5").update(customerKey).digest("base64") }));
    await assert.rejects(client.snapshot.restore({ repository: "backups", snapshot: "good", wait_for_completion: true }), /SSE-C/);
    await env.s3.send(new S3.PutObjectCommand({ Bucket: bucket, Key: key, Body: original, StorageClass: "GLACIER" }));
    await assert.rejects(client.snapshot.restore({ repository: "backups", snapshot: "good", wait_for_completion: true }), /storage class/);
    const malformed = structuredClone(document); malformed.data.indexes[0].documents.push({ id: "invalid", source: {}, seq: -2, version: 1, routing: null });
    await env.s3.send(new S3.PutObjectCommand({ Bucket: bucket, Key: key, Body: gzipSync(Buffer.from(JSON.stringify(malformed))) }));
    await assert.rejects(client.snapshot.restore({ repository: "backups", snapshot: "good", wait_for_completion: true, body: { rename_pattern: "(.+)", rename_replacement: "bad-$1" } }), /integer/); assert.equal((await client.indices.exists({ index: "bad-records" })).body, false);
  } finally { await env.close(); }
});
