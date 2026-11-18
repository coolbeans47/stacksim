import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { EmbeddedSearchEngine } from "../src/opensearch/engine.js";
import { validateIsmPolicy } from "../src/opensearch/ism.js";
import { passwordVerifier, type SearchIdentity } from "../src/opensearch/security.js";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";

const state = (name: string, actions: any[] = [], transitions: any[] = []) => ({ name, actions, transitions });
const policy = (states: any[], extra: any = {}) => ({ policy: { description: "Retention policy", default_state: states[0].name, states, ...extra } });

test("ISM persists policy versions and action checkpoints, blocks all document writes, changes policies and deletes by age", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ism-")), file = join(root, "search.enc"), keyFile = join(root, "key"); let now = 100000, engine = new EmbeddedSearchEngine(file, () => now, { keyFile });
  const call = async (method: string, path: string, body: any = {}) => (await engine.request(method, path, Buffer.from(JSON.stringify(body)), "admin")).body;
  const tick = (ms = 5000) => { now += ms; engine.runIndexManagement(); };
  try {
    const definition = policy([state("hot", [], [{ state_name: "frozen", conditions: { min_doc_count: 1, min_size: "1b" } }]), state("frozen", [{ read_only: {} }], [{ state_name: "expired", conditions: { min_index_age: "40s" } }]), state("expired", [{ delete: {} }])]);
    const created = await call("PUT", "/_plugins/_ism/policies/retention", definition); assert.equal(created._seq_no, 0);
    await assert.rejects(call("PUT", "/_plugins/_ism/policies/retention", definition), { status: 409 });
    await assert.rejects(call("PUT", "/_plugins/_ism/policies/retention?if_seq_no=2&if_primary_term=1", definition), { status: 409 });
    await call("PUT", "/events", { settings: { refresh_interval: "-1" } }); await call("PUT", "/events/_doc/one", { message: "durable" });
    assert.equal((await call("POST", "/_plugins/_ism/add/events", { policy_id: "retention" })).updated_indices, 1);
    assert.equal((await call("POST", "/_plugins/_ism/add/events", { policy_id: "retention" })).failures, true);
    tick(); assert.equal((await call("GET", "/_plugins/_ism/explain/events")).events.state.name, "frozen");
    engine.close(); engine = new EmbeddedSearchEngine(file, () => now, { keyFile }); tick();
    for (const [method, path, body] of [["PUT", "/events/_doc/two", { message: "blocked" }], ["DELETE", "/events/_doc/one", {}], ["POST", "/events/_update/one", { doc: { message: "durable" } }]] as const) await assert.rejects(call(method, path, body), { type: "cluster_block_exception", status: 403 });
    const bulk = await engine.request("PUT", "/events/_bulk", Buffer.from('{"index":{"_id":"blocked"}}\n{"message":"no"}\n'), "admin"); assert.equal(bulk.body.items[0].index.status, 403);
    assert.equal((await call("GET", "/events/_doc/one"))._source.message, "durable");
    const updated = await call("PUT", "/_plugins/_ism/policies/retention?if_seq_no=0&if_primary_term=1", policy([state("writable", [{ read_write: {} }])])); assert.equal(updated._version, 2);
    assert.equal((await call("GET", "/_plugins/_ism/explain/events?show_policy=true")).events.policy_seq_no, 0);
    assert.equal((await call("POST", "/_plugins/_ism/change_policy/events", { policy_id: "retention", include: [{ state: "unmatched" }] })).updated_indices, 0);
    await call("POST", "/_plugins/_ism/change_policy/events", { policy_id: "retention", state: "writable" }); tick();
    assert.equal((await call("GET", "/_plugins/_ism/explain/events")).events.policy_seq_no, 1); await call("PUT", "/events/_doc/two", { message: "allowed" });
    await call("PUT", "/_plugins/_ism/policies/expire", definition); await call("POST", "/_plugins/_ism/change_policy/events", { policy_id: "expire", state: "frozen" }); tick();
    await call("DELETE", "/_plugins/_ism/policies/expire"); tick(30000); tick(); await assert.rejects(call("GET", "/events"), { status: 404 });
    await call("PUT", "/events"); assert.equal((await call("GET", "/_plugins/_ism/explain/events")).total_managed_indices, 0);
    await call("POST", "/_plugins/_ism/add/events", { policy_id: "retention" }); await call("POST", "/_plugins/_ism/remove/events"); tick(); assert.equal((await call("GET", "/_plugins/_ism/explain/events")).total_managed_indices, 0);
    assert.equal((await call("GET", "/_plugins/_ism/policies?from=0&size=1")).total_policies, 1);
    const current = await call("GET", "/_plugins/_ism/policies/retention"); assert.equal((await call("PUT", "/_plugins/_ism/policies/retention?if_seq_no=1&if_primary_term=1", { policy: current.policy }))._version, 3);
  } finally { engine.close(); await rm(root, { recursive: true, force: true }); }
});

test("ISM rollover and templates are atomic, failures retry, and action timeouts persist", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ism-rollover-")); let now = 100000; const engine = new EmbeddedSearchEngine(join(root, "search.db"), () => now);
  const call = async (method: string, path: string, body: any = {}) => (await engine.request(method, path, Buffer.from(JSON.stringify(body)), "admin")).body;
  const tick = (ms = 5000) => { now += ms; engine.runIndexManagement(); };
  try {
    await call("PUT", "/_plugins/_ism/policies/rotate", policy([state("hot", [{ rollover: { min_doc_count: 1 }, retry: { count: 1, delay: "5s", backoff: "constant" } }], [{ state_name: "archive", conditions: { min_rollover_age: "10s" } }]), state("archive", [{ read_only: {} }])], { ism_template: [{ index_patterns: ["events-*"], priority: 10 }] }));
    await call("PUT", "/events-000001", { settings: { "plugins.index_state_management.rollover_alias": "events" }, aliases: { events: { is_write_index: true } } });
    tick(); assert.equal((await call("GET", "/_plugins/_ism/explain/events-*")).total_managed_indices, 1);
    await call("PUT", "/events/_doc/one", { message: "old" }); await call("PUT", "/events-000002"); tick();
    assert.equal((await call("GET", "/events-000001/_alias"))["events-000001"].aliases.events.is_write_index, true);
    assert.equal((await call("GET", "/_plugins/_ism/explain/events-000001"))["events-000001"].action.consumed_retries, 1);
    tick(); assert.equal((await call("GET", "/_plugins/_ism/explain/events-000001"))["events-000001"].retry_info.failed, true);
    await call("DELETE", "/events-000002"); await call("POST", "/_plugins/_ism/retry/events-000001"); tick();
    assert.equal((await call("GET", "/events-000001/_alias"))["events-000001"].aliases.events.is_write_index, false);
    assert.equal((await call("GET", "/events-000002/_alias"))["events-000002"].aliases.events.is_write_index, true);
    assert.equal((await call("GET", "/_plugins/_ism/explain/events-*")).total_managed_indices, 2);
    assert.equal((await call("PUT", "/events/_doc/two", { message: "new" }))._index, "events-000002");
    tick(10000); tick(); await assert.rejects(call("PUT", "/events-000001/_doc/three", {}), { status: 403 });
    await call("PUT", "/_plugins/_ism/policies/timeout", policy([state("hot", [{ rollover: { min_doc_count: 100 }, timeout: "10s" }])]));
    await call("PUT", "/waiting"); await call("POST", "/_plugins/_ism/add/waiting", { policy_id: "timeout" }); tick(); tick();
    assert.match((await call("GET", "/_plugins/_ism/explain/waiting")).waiting.info.message, /timed out/);
    await call("POST", "/_plugins/_ism/change_policy/waiting", { policy_id: "rotate" }); await call("PUT", "/waiting/_doc/one", {}); tick();
    const failedChange = (await call("GET", "/_plugins/_ism/explain/waiting")).waiting; assert.equal(failedChange.policy_id, "rotate"); assert.equal(failedChange.action.name, "rollover");
    await call("PUT", "/_plugins/_ism/policies/tie", policy([state("nothing")], { ism_template: { index_patterns: ["events-*"], priority: 10 } }));
    await assert.rejects(call("PUT", "/events-000099"), /equal priority/); await assert.rejects(call("GET", "/events-000099"), { status: 404 });
  } finally { engine.close(); await rm(root, { recursive: true, force: true }); }
});

test("ISM rechecks current FGAC roles and rejects unsupported or unbounded policies", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ism-auth-")); let now = 100000; const engine = new EmbeddedSearchEngine(join(root, "search.enc"), () => now, { keyFile: join(root, "key") });
  engine.setSecurityMaster({ username: "master", verifier: passwordVerifier("Strong-master-pass1!") });
  const master: SearchIdentity = { name: "master", internal: true, backendRoles: [] }, user: SearchIdentity = { name: "operator", internal: true, backendRoles: [] };
  const call = async (method: string, path: string, body: any = {}, identity = master) => (await engine.request(method, path, Buffer.from(JSON.stringify(body)), identity.name, true, engine.security.access(identity))).body;
  const tick = () => { now += 5000; engine.runIndexManagement(); };
  const role = (manage: boolean) => ({ cluster_permissions: ["index_management_full_access"], index_permissions: [{ index_patterns: ["events"], allowed_actions: manage ? ["manage"] : ["read"] }] });
  try {
    await call("PUT", "/_plugins/_security/api/roles/operator", role(true)); await call("PUT", "/_plugins/_security/api/internalusers/operator", { password: "Strong-operator-pass1!", opendistro_security_roles: ["operator"] });
    await call("PUT", "/events"); await call("PUT", "/_plugins/_ism/policies/freeze", policy([state("cold", [{ read_only: {} }])]));
    await call("POST", "/_plugins/_ism/add/events", { policy_id: "freeze" }, user);
    await call("PUT", "/_plugins/_security/api/roles/operator", role(false)); tick(); assert.equal((await call("GET", "/_plugins/_ism/explain/events")).events.retry_info.failed, true);
    await call("PUT", "/events/_doc/one", { message: "still writable" }); await assert.rejects(call("POST", "/_plugins/_ism/retry/events", {}, user), { status: 403 });
    await call("PUT", "/_plugins/_security/api/roles/operator", role(true)); await call("POST", "/_plugins/_ism/retry/events", {}, user); await call("DELETE", "/_plugins/_security/api/internalusers/operator"); tick();
    assert.match((await call("GET", "/_plugins/_ism/explain/events")).events.info.message, /no longer exists/);
    await call("POST", "/_plugins/_ism/retry/events", {}, master); tick(); await assert.rejects(call("PUT", "/events/_doc/two", {}), { status: 403 });
    await call("PUT", "/_plugins/_security/api/roles/operator", { cluster_permissions: ["index_management_full_access"], index_permissions: [{ index_patterns: ["roll-000001"], allowed_actions: ["manage"] }] });
    await call("PUT", "/_plugins/_security/api/internalusers/operator", { password: "Strong-new-operator1!", opendistro_security_roles: ["operator"] });
    await call("PUT", "/roll-000001", { settings: { "plugins.index_state_management.rollover_alias": "rolling" }, aliases: { rolling: { is_write_index: true } } });
    await call("PUT", "/_plugins/_ism/policies/roll", policy([state("rotate", [{ rollover: {} }])])); await call("POST", "/_plugins/_ism/add/roll-000001", { policy_id: "roll" }, user); tick();
    assert.match((await call("GET", "/_plugins/_ism/explain/roll-000001"))["roll-000001"].info.message, /roll-000002/);
    assert.equal((await call("GET", "/roll-000001/_alias"))["roll-000001"].aliases.rolling.is_write_index, true); await assert.rejects(call("GET", "/roll-000002"), { status: 404 });
    await call("PUT", "/_plugins/_security/api/roles/operator", { cluster_permissions: ["index_management_full_access"], index_permissions: [{ index_patterns: ["roll-*"], allowed_actions: ["manage"] }] }); await call("POST", "/_plugins/_ism/retry/roll-000001", {}, user); tick();
    assert.equal((await call("GET", "/roll-000002/_alias"))["roll-000002"].aliases.rolling.is_write_index, true);
    for (const input of [policy([state("hot", [{ force_merge: {} }])]), policy([state("hot", [], [{ state_name: "missing" }])]), policy([state("hot", [{ read_only: {}, delete: {} }])]), policy([state("hot", [{ rollover: { min_doc_count: null } }])]), policy([state("hot", [{ read_only: {}, retry: { count: 11 } }])]), policy([state("hot")], { error_notification: {} }), policy(Array.from({ length: 33 }, (_, i) => state(`s${i}`)))]) assert.throws(() => validateIsmPolicy(input.policy));
    const serverless = new EmbeddedSearchEngine(join(root, "aoss.db"), () => now, undefined, { refreshIntervalMs: 10000 }); try { await assert.rejects(serverless.request("GET", "/_plugins/_ism/policies", Buffer.alloc(0), "admin"), /managed domains/); } finally { serverless.close(); }
  } finally { engine.close(); await rm(root, { recursive: true, force: true }); }
});

test("managed-domain ISM scheduler executes signed SDK requests and resumes after service restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ism-service-")), region = "eu-west-1", clock = new TestClock(Date.now()), options = { port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce" as const, cdkBootstrap: false, clock }; let sim = new StackSim(options), client: Client | undefined;
  try {
    await sim.start(); await sim.opensearch.execute("CreateDomain", { DomainName: "managed-ism", EncryptionAtRestOptions: { Enabled: true } }, region); for (let i = 0; i < 200 && sim.opensearch.domain(region, "managed-ism").state !== "active"; i++) await delay(10);
    const connection = { node: `https://127.0.0.1:${sim.opensearch.domain(region, "managed-ism").gatewayPort}`, ssl: { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath) }, maxRetries: 0, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => ({ accessKeyId: "admin", secretAccessKey: "password" }) }) }; client = new Client(connection);
    await client.ism.putPolicy({ policy_id: "freeze", body: policy([state("cold", [{ read_only: {} }])]) }); await client.index({ index: "events", id: "one", body: { content: "persisted" } });
    await client.ism.addPolicy({ index: "events", body: { policy_id: "freeze" } });
    await client.close(); client = undefined; await sim.stop(); sim = new StackSim(options); await sim.start(); client = new Client(connection); clock.advance(5000);
    await assert.rejects(client.index({ index: "events", id: "two", body: { content: "blocked" } }), (error: any) => error.statusCode === 403 && error.body.error.type === "cluster_block_exception");
    assert.equal((await client.get({ index: "events", id: "one" })).body._source.content, "persisted");
    assert.equal((await client.ism.explainPolicy({ index: "events" })).body.events.policy_id, "freeze");
  } finally { await client?.close(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
