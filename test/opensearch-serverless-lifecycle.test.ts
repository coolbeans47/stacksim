import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import * as Aoss from "@aws-sdk/client-opensearchserverless";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { IAMClient, CreateUserCommand, CreateAccessKeyCommand, PutUserPolicyCommand } from "@aws-sdk/client-iam";
import { StackSim } from "../src/server.js";
import { TestClock } from "../src/core/clock.js";
import { groupLimits, ServerlessCapacity } from "../src/opensearch/serverless-capacity.js";
import { parseRetentionPolicy, effectiveRetention } from "../src/opensearch/serverless-retention.js";

const region = "eu-west-1", credentials = { accessKeyId: "admin", secretAccessKey: "password" }, day = 86400000;
async function active(client: Aoss.OpenSearchServerlessClient, id: string) {
  for (let i = 0; i < 100; i++) { const value = (await client.send(new Aoss.BatchGetCollectionCommand({ ids: [id] }))).collectionDetails![0]; if (value?.status === "ACTIVE") return value; if (value?.status === "FAILED") throw new Error(value.failureMessage); await delay(10); }
  throw new Error("Collection failed to activate");
}
const rule = (Resource: string[], duration?: string) => ({ ResourceType: "index", Resource, ...(duration ? { MinIndexRetention: duration } : { NoMinIndexRetention: true }) });

test("retention policy precedence and generation capacity cause bounded, independent admission and idle release", () => {
  for (const value of ["23h", "3651d", "1m", "1.5d", "wat"]) assert.throws(() => parseRetentionPolicy(JSON.stringify({ Rules: [rule(["index/logs/*"], value)] })), { code: "ValidationException" });
  for (const invalid of [{ Rules: [{ ...rule(["index/logs/*"], "1d"), NoMinIndexRetention: true }] }, { Rules: [rule(["index/logs/*"]), rule(["index/logs/*"])] }]) assert.throws(() => parseRetentionPolicy(JSON.stringify(invalid)), { code: "ValidationException" });
  const policies = [{ type: "retention" as const, name: "general", policyVersion: "1", createdDate: 0, lastModifiedDate: 0, policy: parseRetentionPolicy(JSON.stringify({ Rules: [rule(["index/logs/*"], "1d"), rule(["index/logs/keep*"])] })) }];
  assert.equal(effectiveRetention(policies, "index/logs/events").milliseconds, day); assert.equal(effectiveRetention(policies, "index/logs/keep-a").milliseconds, Infinity); assert.equal(effectiveRetention(policies, "index/other/events").policyName, undefined);
  assert.throws(() => groupLimits("CLASSIC", { minSearchCapacityInOCU: 0 }), { code: "ValidationException" });
  assert.throws(() => groupLimits("NEXTGEN", { minSearchCapacityInOCU: 1 }), { code: "ValidationException" });
  assert.throws(() => groupLimits("CLASSIC", { maxSearchCapacityInOCU: 3 }), { code: "ValidationException" });
  assert.throws(() => groupLimits("NEXTGEN", { minSearchCapacityInOCU: 8, maxSearchCapacityInOCU: 4 }), { code: "ValidationException" });
  const clock = new TestClock(), capacity = new ServerlessCapacity(() => clock.now()), limits = groupLimits("NEXTGEN", { maxSearchCapacityInOCU: 2, maxIndexingCapacityInOCU: 2 });
  assert.equal(capacity.current("one", limits).search.capacityInOcu, 0);
  const releases = Array.from({ length: 8 }, () => capacity.admit("one", limits, "read", "NEXTGEN"));
  assert.equal(capacity.current("one", limits).search.capacityInOcu, 2);
  assert.throws(() => capacity.admit("one", limits, "read", "NEXTGEN"), { status: 429 });
  const write = capacity.admit("one", limits, "write", "NEXTGEN"), other = capacity.admit("two", limits, "read", "NEXTGEN");
  releases.forEach(release => { release(); release(); }); clock.advance(600000);
  assert.equal(capacity.current("one", limits).search.capacityInOcu, 0); assert.equal(capacity.current("one", limits).indexing.capacityInOcu, 2); assert.equal(capacity.current("two", limits).search.capacityInOcu, 2);
  write(); other(); clock.advance(600000); assert.equal(capacity.current("one", limits).indexing.capacityInOcu, 0);
  const wake = capacity.admit("one", limits, "read", "NEXTGEN"); assert.equal(capacity.current("one", limits).search.capacityInOcu, 2); wake();
});

test("official Serverless clients persist timed retention, preserve newer data and distinguish Classic/NextGen vector writes", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-aoss-retention-")), clock = new TestClock(Date.now());
  t.mock.timers.enable({ apis: ["Date"], now: clock.now() });
  const advance = (ms: number) => { t.mock.timers.tick(ms); clock.advance(ms); };
  let sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false, clock });
  let control: Aoss.OpenSearchServerlessClient | undefined; const searches: Client[] = [];
  const config = () => ({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 });
  const controlClient = () => { const client = new Aoss.OpenSearchServerlessClient(config());
    // HTTP emits the real wall-clock Date header; keep the SDK signing clock
    // aligned with the injected service clock instead of learning that skew.
    Object.defineProperty(client.config, "systemClockOffset", { get: () => 0, set: () => undefined }); return client; };
  try {
    await sim.start(); control = controlClient();
    const adminArn = Object.values(sim.store.state.accounts[sim.store.accountId].iam.users).find(user => user.userName === "admin")!.arn;
    await control.send(new Aoss.CreateSecurityPolicyCommand({ name: "net", type: "network", policy: JSON.stringify([{ Rules: [{ ResourceType: "collection", Resource: ["collection/*"] }], AllowFromPublic: true }]) }));
    await control.send(new Aoss.CreateAccessPolicyCommand({ name: "access", type: "data", policy: JSON.stringify([{ Rules: [{ ResourceType: "index", Resource: ["index/*/*"], Permission: ["aoss:*"] }], Principal: [adminArn] }]) }));
    const group = (await control.send(new Aoss.CreateCollectionGroupCommand({ name: "log-group", standbyReplicas: "DISABLED", generation: "NEXTGEN", capacityLimits: { maxIndexingCapacityInOCU: 2, maxSearchCapacityInOCU: 2 }, clientToken: "group-once" }))).createCollectionGroupDetail!;
    assert.equal((await control.send(new Aoss.CreateCollectionGroupCommand({ name: "log-group", standbyReplicas: "DISABLED", generation: "NEXTGEN", capacityLimits: { maxIndexingCapacityInOCU: 2, maxSearchCapacityInOCU: 2 }, clientToken: "group-once" }))).createCollectionGroupDetail!.id, group.id);
    await assert.rejects(control.send(new Aoss.CreateCollectionGroupCommand({ name: "bad-classic", standbyReplicas: "ENABLED", capacityLimits: { minSearchCapacityInOCU: 0 } })), { name: "ValidationException" });
    await assert.rejects(control.send(new Aoss.CreateCollectionCommand({ name: "classic_underscore", type: "SEARCH", encryptionConfig: { aWSOwnedKey: true } })), { name: "ValidationException" });
    const created = (await control.send(new Aoss.CreateCollectionCommand({ name: "time-logs", collectionGroupName: group.name, encryptionConfig: { aWSOwnedKey: true } }))).createCollectionDetail!;
    const collection = await active(control, created.id!); assert.equal(collection.type, "TIMESERIES"); assert.equal(collection.standbyReplicas, "DISABLED");
    await assert.rejects(control.send(new Aoss.DeleteCollectionGroupCommand({ id: group.id })), { name: "ConflictException" });
    await assert.rejects(control.send(new Aoss.CreateCollectionCommand({ name: "wrong-kind", type: "SEARCH", collectionGroupName: group.name, encryptionConfig: { aWSOwnedKey: true } })), { name: "ValidationException" });
    let policy = (await control.send(new Aoss.CreateLifecyclePolicyCommand({ name: "expiry", type: "retention", policy: JSON.stringify({ Rules: [rule(["index/time-logs/*"], "24h"), rule(["index/time-logs/keep*"])] }) }))).lifecyclePolicyDetail!;
    await assert.rejects(control.send(new Aoss.CreateLifecyclePolicyCommand({ name: "conflict", type: "retention", policy: JSON.stringify({ Rules: [rule(["index/time-logs/*"], "2d")] }) })), { name: "ConflictException" });
    const ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath);
    const client = (endpoint: string) => { const search = new Client({ node: endpoint, ssl: { ca }, ...AwsSigv4Signer({ region, service: "aoss", getCredentials: async () => credentials }) }); searches.push(search); return search; };
    let search = client(collection.collectionEndpoint!);
    await search.indices.create({ index: "events" }); await search.indices.create({ index: "keep-forever" });
    await assert.rejects(search.indices.create({ index: "invalid-knn", body: { settings: { index: { knn: true } } } }), (error: any) => error.statusCode === 400);
    const old = (await search.index({ index: "events", body: { message: "old" } })).body._id;
    await search.index({ index: "keep-forever", body: { message: "kept" } });
    await assert.rejects(search.index({ index: "events", id: "explicit", body: {} }), (error: any) => error.statusCode === 400);
    const bulk = (await search.bulk({ body: [{ index: { _index: "events", _id: "bad" } }, { message: "rejected" }, { index: { _index: "events" } }, { message: "bulk" }] })).body;
    assert.equal(bulk.items[0].index!.status, 400); assert.equal(bulk.items[1].index!.status, 201);
    assert.equal((await search.count({ index: "events" })).body.count, 0);
    advance(day / 2); const newer = (await search.index({ index: "events", body: { message: "newer" } })).body._id;
    advance(day / 2 - 1); assert.equal((await search.get({ index: "events", id: old })).body.found, true);
    // Restart before the deadline; ingestion times are encrypted and durable.
    searches.splice(searches.indexOf(search), 1); await search.close(); control.destroy(); await sim.stop(); sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false, clock }); await sim.start(); control = controlClient(); search = client(collection.collectionEndpoint!);
    advance(1); assert.equal((await search.count({ index: "events" })).body.count, 1); await assert.rejects(search.get({ index: "events", id: old }), (error: any) => error.statusCode === 404); assert.equal((await search.get({ index: "events", id: newer })).body._source.message, "newer"); assert.equal((await search.count({ index: "keep-forever" })).body.count, 1);
    const effective = await control.send(new Aoss.BatchGetEffectiveLifecyclePolicyCommand({ resourceIdentifiers: [{ type: "retention", resource: "index/time-logs/events" }, { type: "retention", resource: "index/time-logs/keep-forever" }, { type: "retention", resource: "index/missing/events" }] }));
    assert.equal(effective.effectiveLifecyclePolicyDetails?.[0].retentionPeriod, "24h"); assert.equal(effective.effectiveLifecyclePolicyDetails?.[1].noMinRetentionPeriod, true); assert.equal(effective.effectiveLifecyclePolicyErrorDetails?.length, 1);
    assert.equal((await control.send(new Aoss.ListLifecyclePoliciesCommand({ type: "retention", resources: ["index/time-logs/events"] }))).lifecyclePolicySummaries?.length, 1);
    assert.equal((await control.send(new Aoss.BatchGetLifecyclePolicyCommand({ identifiers: [{ name: "expiry", type: "retention" }, { name: "absent", type: "retention" }] }))).lifecyclePolicyErrorDetails?.length, 1);
    policy = (await control.send(new Aoss.UpdateLifecyclePolicyCommand({ name: "expiry", type: "retention", policyVersion: policy.policyVersion!, policy: JSON.stringify({ Rules: [rule(["index/time-logs/*"])] }) }))).lifecyclePolicyDetail!;
    await assert.rejects(control.send(new Aoss.UpdateLifecyclePolicyCommand({ name: "expiry", type: "retention", policyVersion: Buffer.alloc(16).toString("base64"), description: "stale" })), { name: "ConflictException" });
    advance(day * 2); assert.equal((await search.count({ index: "events" })).body.count, 1);
    assert.equal((await control.send(new Aoss.GetPoliciesStatsCommand({}))).LifecyclePolicyStats?.RetentionPolicyCount, 1);
    await control.send(new Aoss.DeleteLifecyclePolicyCommand({ name: "expiry", type: "retention" }));
    await control.send(new Aoss.TagResourceCommand({ resourceArn: group.arn!, tags: [{ key: "__proto__", value: "literal" }] }));
    assert.equal((await control.send(new Aoss.ListTagsForResourceCommand({ resourceArn: group.arn! }))).tags?.[0].value, "literal");
    await control.send(new Aoss.UpdateCollectionGroupCommand({ id: group.id!, description: "updated", capacityLimits: { minSearchCapacityInOCU: 2 } }));
    assert.equal((await control.send(new Aoss.BatchGetCollectionGroupCommand({ names: [group.name!] }))).collectionGroupDetails?.[0].numberOfCollections, 1);
    assert.equal((await control.send(new Aoss.ListCollectionGroupsCommand({}))).collectionGroupSummaries?.[0].id, group.id);
    for (const generation of ["CLASSIC", "NEXTGEN"] as const) {
      const groupName = `vectors-${generation.toLowerCase()}`;
      await control.send(new Aoss.CreateCollectionGroupCommand({ name: groupName, generation, standbyReplicas: "ENABLED" }));
      const vector = await active(control, (await control.send(new Aoss.CreateCollectionCommand({ name: groupName, type: "VECTORSEARCH", collectionGroupName: groupName, encryptionConfig: { aWSOwnedKey: true } }))).createCollectionDetail!.id!);
      const vectors = client(vector.collectionEndpoint!);
      await vectors.indices.create({ index: "vectors", body: { settings: { index: { knn: true } }, mappings: { properties: { embedding: { type: "knn_vector", dimension: 2 } } } } });
      if (generation === "CLASSIC") await assert.rejects(vectors.index({ index: "vectors", id: "custom", body: { embedding: [1, 0] } }), (error: any) => error.statusCode === 400);
      else await vectors.index({ index: "vectors", id: "custom", body: { embedding: [1, 0] } });
      await vectors.index({ index: "vectors", body: { embedding: [0, 1] } }); advance(10000);
      assert.equal((await vectors.count({ index: "vectors" })).body.count, generation === "NEXTGEN" ? 2 : 0);
      if (generation === "CLASSIC") advance(50000);
      const hits = (await vectors.search({ index: "vectors", body: { query: { knn: { embedding: { vector: [0, 1], k: 1 } } } } })).body.hits.hits;
      assert.deepEqual(hits[0]._source.embedding, [0, 1]);
    }
  } catch (error: any) { if (error.meta?.body) error.message += `: ${JSON.stringify(error.meta.body)}`; throw error; }
  finally { for (const search of searches) await search.close(); control?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test("Serverless policy resource conditions and group membership IAM cannot be bypassed by administrator data rights", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-aoss-conditions-")), sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false });
  let admin: Aoss.OpenSearchServerlessClient | undefined, user: Aoss.OpenSearchServerlessClient | undefined, iam: IAMClient | undefined;
  try {
    await sim.start(); const config = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }; admin = new Aoss.OpenSearchServerlessClient(config); iam = new IAMClient(config);
    const group = (await admin.send(new Aoss.CreateCollectionGroupCommand({ name: "group", standbyReplicas: "ENABLED", generation: "NEXTGEN" }))).createCollectionGroupDetail!;
    await iam.send(new CreateUserCommand({ UserName: "author" })); const key = (await iam.send(new CreateAccessKeyCommand({ UserName: "author" }))).AccessKey!;
    user = new Aoss.OpenSearchServerlessClient({ ...config, credentials: { accessKeyId: key.AccessKeyId!, secretAccessKey: key.SecretAccessKey! } });
    const statements: any[] = [{ Effect: "Allow", Action: ["aoss:CreateCollection", "aoss:BatchGetCollection"], Resource: "*", Condition: { StringEquals: { "aoss:collection": "permitted" } } }, { Effect: "Allow", Action: "aoss:CreateLifecyclePolicy", Resource: "*", Condition: { StringEquals: { "aoss:collection": "permitted", "aoss:index": "events" } } }];
    const put = () => iam!.send(new PutUserPolicyCommand({ UserName: "author", PolicyName: "scoped", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: statements }) })); await put();
    const create = () => user!.send(new Aoss.CreateCollectionCommand({ name: "permitted", collectionGroupName: group.name, encryptionConfig: { aWSOwnedKey: true } }));
    await assert.rejects(create(), { name: "AccessDeniedException" });
    statements.push({ Effect: "Allow", Action: "aoss:AddCollectionToCollectionGroup", Resource: group.arn }); await put();
    const collection = await create(); assert.ok(collection.createCollectionDetail?.id); await active(user, collection.createCollectionDetail!.id!);
    await user.send(new Aoss.CreateLifecyclePolicyCommand({ name: "scoped", type: "retention", policy: JSON.stringify({ Rules: [rule(["index/permitted/events"], "1d")] }) }));
    await assert.rejects(user.send(new Aoss.CreateLifecyclePolicyCommand({ name: "mixed", type: "retention", policy: JSON.stringify({ Rules: [rule(["index/permitted/events", "index/forbidden/events"], "2d")] }) })), { name: "AccessDeniedException" });
  } finally { admin?.destroy(); user?.destroy(); iam?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
