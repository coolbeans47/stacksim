import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import * as Aoss from "@aws-sdk/client-opensearchserverless";
import { IAMClient, CreateUserCommand, CreateAccessKeyCommand, PutUserPolicyCommand, DeleteUserPolicyCommand } from "@aws-sdk/client-iam";
import { StackSim } from "../src/server.js";
import { TestClock } from "../src/core/clock.js";
import { parseServerlessPolicy, serverlessAccess } from "../src/opensearch/serverless-policies.js";

const region = "eu-west-1", credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const encryption = JSON.stringify({ Rules: [{ ResourceType: "collection", Resource: ["collection/products*"] }], AWSOwnedKey: true });
const network = (allowed: boolean, kind = "collection") => JSON.stringify([{ Rules: [{ ResourceType: kind, Resource: ["collection/products*"] }], AllowFromPublic: allowed }]);
const grant = (principal: string, permissions = ["aoss:*"], index = "*") => ({ Rules: [{ ResourceType: "index", Resource: [`index/products*/${index}`], Permission: permissions }], Principal: [principal] });
async function active(client: Aoss.OpenSearchServerlessClient, id: string) {
  for (let i = 0; i < 100; i++) { const collection = (await client.send(new Aoss.BatchGetCollectionCommand({ ids: [id] }))).collectionDetails![0]; if (collection?.status === "ACTIVE") return collection; if (collection?.status === "FAILED") throw new Error(collection.failureMessage); await delay(10); }
  throw new Error("Collection did not activate");
}
async function noPlaintext(directory: string, secret: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await noPlaintext(path, secret);
    else { const data = await readFile(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return Buffer.alloc(0); throw error; }); assert.equal(data.includes(Buffer.from(secret)), false, path); }
  }
}

test("Serverless official clients enforce independent policies, encrypted persistence, refresh and deletion isolation", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-aoss-")), clock = new TestClock(Date.now());
  let sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false, clock });
  let control: Aoss.OpenSearchServerlessClient | undefined, other: Aoss.OpenSearchServerlessClient | undefined, iam: IAMClient | undefined;
  let search: Client | undefined, reader: Client | undefined;
  try {
    await sim.start(); const config = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 };
    control = new Aoss.OpenSearchServerlessClient(config); other = new Aoss.OpenSearchServerlessClient({ ...config, region: "us-east-1" }); iam = new IAMClient(config);
    await assert.rejects(control.send(new Aoss.CreateCollectionCommand({ name: "products", type: "SEARCH" })), { name: "ValidationException" });
    const ep = await control.send(new Aoss.CreateSecurityPolicyCommand({ name: "encryption", type: "encryption", policy: encryption, clientToken: "encryption-once" }));
    assert.deepEqual((await control.send(new Aoss.GetSecurityPolicyCommand({ name: "encryption", type: "encryption" }))).securityPolicyDetail?.policy, JSON.parse(encryption));
    await assert.rejects(control.send(new Aoss.UpdateSecurityPolicyCommand({ name: "encryption", type: "encryption", policyVersion: Buffer.alloc(16).toString("base64"), policy: encryption })), { name: "ConflictException" });
    assert.equal((await control.send(new Aoss.CreateSecurityPolicyCommand({ name: "encryption", type: "encryption", policy: encryption, clientToken: "encryption-once" }))).securityPolicyDetail?.policyVersion, ep.securityPolicyDetail?.policyVersion);
    await assert.rejects(control.send(new Aoss.CreateSecurityPolicyCommand({ name: "different", type: "encryption", policy: encryption, clientToken: "encryption-once" })), { name: "ConflictException" });
    const created = await control.send(new Aoss.CreateCollectionCommand({ name: "products", type: "SEARCH", clientToken: "collection-once", tags: [{ key: "app", value: "shop" }] }));
    const id = created.createCollectionDetail!.id!; assert.equal(created.createCollectionDetail?.status, "CREATING");
    const collection = await active(control, id), endpoint = collection.collectionEndpoint!, ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath);
    assert.equal((await control.send(new Aoss.CreateCollectionCommand({ name: "products", type: "SEARCH", clientToken: "collection-once", tags: [{ key: "app", value: "shop" }] }))).createCollectionDetail?.id, id);
    search = new Client({ node: endpoint, ssl: { ca }, ...AwsSigv4Signer({ region, service: "aoss", getCredentials: async () => credentials }) });
    await assert.rejects(search.indices.create({ index: "items" }), (error: any) => error.statusCode === 403 && error.meta.headers["x-aoss-response-hint"] === "X01:network-policy-deny");
    let np = (await control.send(new Aoss.CreateSecurityPolicyCommand({ name: "network", type: "network", policy: network(true, "dashboard") }))).securityPolicyDetail!;
    await assert.rejects(search.indices.create({ index: "items" }), (error: any) => error.statusCode === 403);
    np = (await control.send(new Aoss.UpdateSecurityPolicyCommand({ name: "network", type: "network", policyVersion: np.policyVersion!, policy: network(true) }))).securityPolicyDetail!;
    // An IAM administrator still needs a data policy.
    await assert.rejects(search.indices.create({ index: "items" }), (error: any) => error.statusCode === 403);
    const adminArn = Object.values(sim.store.state.accounts[sim.store.accountId].iam.users).find(user => user.userName === "admin")!.arn;
    let ap = (await control.send(new Aoss.CreateAccessPolicyCommand({ name: "access", type: "data", policy: JSON.stringify([grant(adminArn)]) }))).accessPolicyDetail!;
    await control.send(new Aoss.CreateIndexCommand({ id, indexName: "items", indexSchema: { mappings: { properties: { title: { type: "text" } } } } }));
    await control.send(new Aoss.UpdateIndexCommand({ id, indexName: "items", indexSchema: { mappings: { properties: { price: { type: "double" } } } } }));
    assert.equal(((await control.send(new Aoss.GetIndexCommand({ id, indexName: "items" }))).indexSchema as any).mappings.properties.price.type, "double");
    await assert.rejects(search.indices.putSettings({ index: "items", body: { "index.search.slowlog.threshold.query.warn": "0ms" } }), /Slow log settings/);
    const secret = "encrypted-serverless-document-574b9a";
    await search.index({ index: "items", id: "1", body: { title: secret, price: 4 } });
    assert.equal((await search.get({ index: "items", id: "1" })).body._source.title, secret);
    assert.equal((await search.count({ index: "items" })).body.count, 0); clock.advance(10001);
    assert.equal((await search.count({ index: "items" })).body.count, 1);
    await assert.rejects(search.indices.refresh({ index: "items" }), (error: any) => error.statusCode === 400);
    await assert.rejects(search.index({ index: "items", id: "2", body: { title: "refresh" }, refresh: true }), (error: any) => error.statusCode === 400);
    assert.equal((await search.cat.indices({ format: "json" })).body[0].health, undefined);
    await noPlaintext(root, secret);
    assert.equal((await other.send(new Aoss.ListCollectionsCommand({}))).collectionSummaries?.length, 0);
    assert.equal((await other.send(new Aoss.BatchGetCollectionCommand({ ids: [id] }))).collectionErrorDetails?.[0].errorCode, "RESOURCE_NOT_FOUND");

    const user = (await iam.send(new CreateUserCommand({ UserName: "aoss-reader" }))).User!;
    const accessKey = (await iam.send(new CreateAccessKeyCommand({ UserName: "aoss-reader" }))).AccessKey!;
    const readerCredentials = { accessKeyId: accessKey.AccessKeyId!, secretAccessKey: accessKey.SecretAccessKey! };
    ap = (await control.send(new Aoss.UpdateAccessPolicyCommand({ name: "access", type: "data", policyVersion: ap.policyVersion!, policy: JSON.stringify([grant(adminArn), grant(user.Arn!, ["aoss:ReadDocument"], "items")]) }))).accessPolicyDetail!;
    reader = new Client({ node: endpoint, ssl: { ca }, ...AwsSigv4Signer({ region, service: "aoss", getCredentials: async () => readerCredentials }) });
    await assert.rejects(reader.count({ index: "items" }), (error: any) => error.statusCode === 403);
    await iam.send(new PutUserPolicyCommand({ UserName: "aoss-reader", PolicyName: "endpoint", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "aoss:APIAccessAll", Resource: collection.arn }] }) }));
    assert.equal((await reader.count({ index: "items" })).body.count, 1);
    await assert.rejects(reader.index({ index: "items", id: "unauthorized", body: {} }), (error: any) => error.statusCode === 403);
    const multi = (await reader.msearch({ body: [{ index: "items" }, {}, { index: "hidden" }, {}] })).body.responses;
    assert.equal((multi[0] as any).hits.total.value, 1); assert.equal((multi[1] as any).status, 403);
    await iam.send(new DeleteUserPolicyCommand({ UserName: "aoss-reader", PolicyName: "endpoint" }));
    await assert.rejects(reader.count({ index: "items" }), (error: any) => error.statusCode === 403);
    await reader.close(); reader = undefined;
    await control.send(new Aoss.UpdateCollectionCommand({ id, deletionProtection: "ENABLED" }));
    await assert.rejects(control.send(new Aoss.DeleteCollectionCommand({ id })), { name: "ConflictException" });
    await control.send(new Aoss.TagResourceCommand({ resourceArn: collection.arn!, tags: [{ key: "owner", value: "test" }] }));
    assert.equal((await control.send(new Aoss.ListTagsForResourceCommand({ resourceArn: collection.arn! }))).tags?.length, 2);
    await control.send(new Aoss.UntagResourceCommand({ resourceArn: collection.arn!, tagKeys: ["owner"] }));
    await control.send(new Aoss.UpdateAccountSettingsCommand({ capacityLimits: { maxSearchCapacityInOCU: 2 } }));
    assert.equal((await control.send(new Aoss.GetAccountSettingsCommand({}))).accountSettingsDetail?.capacityLimits?.maxSearchCapacityInOCU, 2);
    assert.equal((await control.send(new Aoss.GetPoliciesStatsCommand({}))).TotalPolicyCount, 3);
    await search.close(); search = undefined; control.destroy(); other.destroy(); iam.destroy();
    await sim.stop(); sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false, clock }); await sim.start();
    control = new Aoss.OpenSearchServerlessClient({ ...config, endpoint: `http://127.0.0.1:${sim.port}` });
    assert.equal((await active(control, id)).collectionEndpoint, endpoint);
    search = new Client({ node: endpoint, ssl: { ca }, ...AwsSigv4Signer({ region, service: "aoss", getCredentials: async () => credentials }) });
    assert.equal((await search.get({ index: "items", id: "1" })).body._source.title, secret);
    np = (await control.send(new Aoss.UpdateSecurityPolicyCommand({ name: "network", type: "network", policyVersion: np.policyVersion!, policy: network(false) }))).securityPolicyDetail!;
    await assert.rejects(search.count({ index: "items" }), (error: any) => error.statusCode === 403);
    await control.send(new Aoss.UpdateCollectionCommand({ id, deletionProtection: "DISABLED" }));
    await search.close(); search = undefined; await control.send(new Aoss.DeleteCollectionCommand({ id }));
    for (let i = 0; i < 100 && (await control.send(new Aoss.ListCollectionsCommand({}))).collectionSummaries!.length; i++) await delay(10);
    assert.deepEqual((await control.send(new Aoss.ListCollectionsCommand({}))).collectionSummaries, []);
    const replacement = await control.send(new Aoss.CreateCollectionCommand({ name: "products", type: "SEARCH" }));
    assert.notEqual((await active(control, replacement.createCollectionDetail!.id!)).collectionEndpoint, endpoint);
  } catch (error: any) { if (error.meta?.body) error.message += `: ${JSON.stringify(error.meta.body)}`; throw error; }
  finally { await search?.close(); await reader?.close(); control?.destroy(); other?.destroy(); iam?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test("Serverless policy validation rejects unknown semantics and evaluates exact principal/index scope", () => {
  for (const [type, policy] of [
    ["encryption", { Rules: [{ ResourceType: "collection", Resource: ["collection/products"] }], AWSOwnedKey: false, KmsARN: "arn:aws:kms:eu-west-1:000000000000:key/fake" }],
    ["network", [{ Rules: [{ ResourceType: "collection", Resource: ["collection/*"] }], AllowFromPublic: false, SourceVPCEs: ["vpce-fake"] }]],
    ["data", [{ ...grant("arn:aws:iam::000000000000:user/a"), Effect: "Deny" }]],
    ["data", [grant("*")]],
    ["data", [grant("arn:aws:iam::000000000000:user/a", ["aoss:CreateCollection"])]]
  ] as const) assert.throws(() => parseServerlessPolicy(type, JSON.stringify(policy)), { code: "ValidationException" });
  const principal = "arn:aws:iam::000000000000:role/reader", document = parseServerlessPolicy("data", JSON.stringify([grant(principal, ["aoss:ReadDocument"], "public-*")]));
  const access = serverlessAccess([{ type: "data", name: "reader", policyVersion: "v1", policy: document, createdDate: 0, lastModifiedDate: 0 }], "products", principal);
  access.index("public-one", "indices:data/read/search");
  assert.throws(() => access.index("private", "indices:data/read/search"), { status: 403 });
  assert.throws(() => access.index("public-one", "indices:data/write/index"), { status: 403 });
});

test("Serverless pagination, save failure and missing encryption keys fail without changing resource identity", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-aoss-faults-"));
  let sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false });
  let client: Aoss.OpenSearchServerlessClient | undefined;
  try {
    await sim.start(); const options = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }; client = new Aoss.OpenSearchServerlessClient(options);
    await client.send(new Aoss.CreateSecurityPolicyCommand({ name: "encryption", type: "encryption", policy: encryption }));
    await assert.rejects(client.send(new Aoss.CreateCollectionCommand({ name: "products-default", vectorOptions: { ServerlessVectorAcceleration: "ENABLED" } })), /acceleration/);
    for (const name of ["access-one", "access-two", "access-three"]) await client.send(new Aoss.CreateAccessPolicyCommand({ name, type: "data", policy: JSON.stringify([grant("arn:aws:iam::000000000000:role/reader")]) }));
    const first = await client.send(new Aoss.ListAccessPoliciesCommand({ type: "data", maxResults: 2 })); assert.equal(first.accessPolicySummaries?.length, 2); assert.ok(first.nextToken);
    const next = await client.send(new Aoss.ListAccessPoliciesCommand({ type: "data", maxResults: 2, nextToken: first.nextToken })); assert.equal(next.accessPolicySummaries?.length, 1); assert.equal(next.nextToken, undefined);
    await assert.rejects(client.send(new Aoss.ListSecurityPoliciesCommand({ type: "encryption", nextToken: first.nextToken })), { name: "ValidationException" });
    const policy = (await client.send(new Aoss.GetAccessPolicyCommand({ name: "access-one", type: "data" }))).accessPolicyDetail!;
    const save = sim.store.save.bind(sim.store); sim.store.save = async () => { throw new Error("Injected catalog write failure"); };
    try { await assert.rejects(client.send(new Aoss.UpdateAccessPolicyCommand({ name: "access-one", type: "data", policyVersion: policy.policyVersion!, description: "must not publish" })), { name: "InternalServerException" }); }
    finally { sim.store.save = save; }
    const unchanged = (await client.send(new Aoss.GetAccessPolicyCommand({ name: "access-one", type: "data" }))).accessPolicyDetail!; assert.equal(unchanged.policyVersion, policy.policyVersion); assert.equal(unchanged.description, undefined);
    await client.send(new Aoss.DeleteAccessPolicyCommand({ name: "access-one", type: "data" }));
    await assert.rejects(client.send(new Aoss.ListAccessPoliciesCommand({ type: "data", maxResults: 2, nextToken: first.nextToken })), { name: "ValidationException" });
    assert.equal((await client.send(new Aoss.ListSecurityPoliciesCommand({ type: "encryption", resource: ["collection/products"] }))).securityPolicySummaries?.length, 1);
    const created = (await client.send(new Aoss.CreateCollectionCommand({ name: "products-keyloss", type: "SEARCH" }))).createCollectionDetail!;
    await active(client, created.id!); const record = sim.opensearch.serverless.collection(region, created.id!);
    assert.throws(() => sim.opensearch.serverless.collection(region, "constructor"), { code: "ResourceNotFoundException" });
    client.destroy(); await sim.stop(); await rm(join(root, "secrets", "opensearchserverless", `${record.generation}.key`));
    sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false }); await sim.start();
    client = new Aoss.OpenSearchServerlessClient({ ...options, endpoint: `http://127.0.0.1:${sim.port}` });
    const failed = (await client.send(new Aoss.BatchGetCollectionCommand({ ids: [record.id] }))).collectionDetails![0]; assert.equal(failed.status, "FAILED"); assert.equal(failed.collectionEndpoint, undefined); assert.equal(sim.opensearch.serverless.collection(region, record.id).generation, record.generation);
    await client.send(new Aoss.DeleteCollectionCommand({ id: record.id }));
    for (let i = 0; i < 100 && Object.keys(sim.opensearch.serverless.state(region).collections).length; i++) await delay(10);
    assert.equal(Object.keys(sim.opensearch.serverless.state(region).collections).length, 0);
  } finally { client?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
