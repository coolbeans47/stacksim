import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as Logs from "@aws-sdk/client-cloudwatch-logs";
import * as OpenSearch from "@aws-sdk/client-opensearch";
import { Client } from "@opensearch-project/opensearch";
import { StackSim } from "../src/server.js";
import { validateAudit, patchAudit, defaultAudit } from "../src/opensearch/audit.js";

test("audit REST events require both publishing and protected capture, obey filters, preserve privacy and recover after restart", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-audit-")), region = "eu-west-1", credentials = { accessKeyId: "admin", secretAccessKey: "password" }, options = { dataDir: root, port: 0, invokePort: 0, authMode: "enforce" as const, cdkBootstrap: false };
  let sim = new StackSim(options), logs: Logs.CloudWatchLogsClient | undefined, control: OpenSearch.OpenSearchClient | undefined, master: Client | undefined, reader: Client | undefined, invalid: Client | undefined;
  try {
    await sim.start(); const sdk = () => ({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }); logs = new Logs.CloudWatchLogsClient(sdk()); control = new OpenSearch.OpenSearchClient(sdk());
    const name = "audited-domain", arn = `arn:aws:es:${region}:${sim.store.accountId}:domain/${name}`, group = "/aws/opensearch/audit", groupArn = `arn:aws:logs:${region}:${sim.store.accountId}:log-group:${group}`;
    await logs.send(new Logs.CreateLogGroupCommand({ logGroupName: group }));
    const policy = (Effect: string) => JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect, Principal: { Service: "es.amazonaws.com" }, Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: `${groupArn}:*`, Condition: { ArnEquals: { "aws:SourceArn": arn } } }] });
    await logs.send(new Logs.PutResourcePolicyCommand({ policyName: "audit", policyDocument: policy("Allow") }));
    const publishing = { AUDIT_LOGS: { Enabled: true, CloudWatchLogsLogGroupArn: groupArn } };
    await assert.rejects(control.send(new OpenSearch.CreateDomainCommand({ DomainName: name, LogPublishingOptions: publishing })), /fine-grained/);
    await control.send(new OpenSearch.CreateDomainCommand({ DomainName: name, EncryptionAtRestOptions: { Enabled: true }, NodeToNodeEncryptionOptions: { Enabled: true }, AdvancedSecurityOptions: { Enabled: true, InternalUserDatabaseEnabled: true, MasterUserOptions: { MasterUserName: "master", MasterUserPassword: "Audit-master-password1!" } }, AccessPolicies: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "es:ESHttp*", Resource: `${arn}/*` }] }), LogPublishingOptions: publishing }));
    for (let i = 0; i < 200 && sim.opensearch.domain(region, name).state !== "active"; i++) await delay(10);
    let domain = sim.opensearch.domain(region, name); const connection = { node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath) }, maxRetries: 0 };
    master = new Client({ ...connection, auth: { username: "master", password: "Audit-master-password1!" } }); invalid = new Client({ ...connection, auth: { username: "bad", password: "Do-not-log-password1!" } });
    const security = async (method: "GET" | "PUT" | "PATCH", path: string, body?: any, client = master!) => (await client.transport.request({ method, path: `/_plugins/_security/api/${path}`, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).body as any;
    const events = async () => ((await logs!.send(new Logs.FilterLogEventsCommand({ logGroupName: group, logStreamNamePrefix: `opensearch/${domain.generation}/AUDIT_LOGS` }))).events ?? []).map(event => JSON.parse(event.message!));
    assert.equal((await security("GET", "audit")).config.enabled, false); await assert.rejects(invalid.search({ body: { query: { match_all: {} } } }), (error: any) => error.statusCode === 401); assert.equal((await events()).length, 0);
    await security("PUT", "roles/reader", { index_permissions: [{ index_patterns: ["records"], allowed_actions: ["read"] }] });
    await security("PUT", "internalusers/reader", { password: "Audit-reader-password1!", opendistro_security_roles: ["reader"] }); reader = new Client({ ...connection, auth: { username: "reader", password: "Audit-reader-password1!" } });
    await master.index({ index: "records", id: "one", body: { content: "audit-source-must-stay-private-867a" }, refresh: true });
    await security("PUT", "audit/config", { enabled: true });
    await assert.rejects(invalid.search({ index: "records" }), (error: any) => error.statusCode === 401);
    await reader.search({ index: "records" }); await assert.rejects(reader.index({ index: "records", id: "forbidden", body: { content: "unauthorized-source" } }), (error: any) => error.statusCode === 403);
    let recorded = await events(); assert.deepEqual(recorded.map(event => event.audit_category), ["FAILED_LOGIN", "MISSING_PRIVILEGES"]); assert.equal(recorded[1].audit_request_effective_user, "reader");
    await assert.rejects(security("GET", "audit", undefined, reader), (error: any) => error.statusCode === 403);
    const before = (await security("GET", "audit")).config; await assert.rejects(security("PATCH", "audit", [{ op: "replace", path: "/config/enabled", value: false }, { op: "replace", path: "/config/audit/log_request_body", value: true }])); assert.deepEqual((await security("GET", "audit")).config, before);
    await security("PATCH", "audit", [{ op: "replace", path: "/config/audit/disabled_rest_categories", value: [] }, { op: "replace", path: "/config/audit/resolve_indices", value: true }]);
    await reader.search({ index: "records", body: { query: { match_all: {} } } });
    recorded = await events(); const successful = recorded.filter(event => event.audit_rest_request_path === "/records/_search" && event.audit_request_effective_user === "reader"); assert.deepEqual(successful.map(event => event.audit_category), ["AUTHENTICATED", "GRANTED_PRIVILEGES"]); assert.deepEqual(successful[1].audit_trace_resolved_indices, ["records"]);
    const bulk = await reader.bulk({ index: "records", body: [{ index: { _id: "blocked" } }, { content: "private-bulk" }] }); assert.equal(bulk.body.items[0].index?.status, 403); assert.ok((await events()).some(event => event.audit_category === "MISSING_PRIVILEGES" && event.audit_rest_request_path.includes("_bulk")));
    const written = await master.bulk({ index: "records", body: [{ index: { _id: "allowed-bulk" } }, { content: "private-bulk" }] }); assert.equal(written.body.items[0].index?.status, 201); assert.equal((await master.get({ index: "records", id: "allowed-bulk" })).body._source.content, "private-bulk");
    await security("PATCH", "audit/config", [{ op: "replace", path: "/audit/ignore_users", value: ["reader"] }, { op: "replace", path: "/audit/ignore_requests", value: ["/records/_search"] }]); const count = (await events()).length;
    await reader.search({ index: "records" }); await master.search({ index: "records" }); assert.equal((await events()).length, count);
    recorded = await events(); assert.ok(recorded.every(event => JSON.stringify(event).length < 10000)); assert.equal(/Audit-master-password|Do-not-log|audit-source-must|unauthorized-source|private-bulk/.test(JSON.stringify(recorded)), false);
    await logs.send(new Logs.PutResourcePolicyCommand({ policyName: "audit-deny", policyDocument: policy("Deny") })); await master.index({ index: "records", id: "acknowledged", body: { content: "committed" } }); assert.ok(domain.logDeliveryFailures?.AUDIT_LOGS.count);
    await logs.send(new Logs.DeleteResourcePolicyCommand({ policyName: "audit-deny" })); await master.get({ index: "records", id: "acknowledged" }); assert.equal(domain.logDeliveryFailures?.AUDIT_LOGS, undefined);
    const savedConfig = (await security("GET", "audit")).config;
    await Promise.all([master.close(), reader.close(), invalid.close()]); master = reader = invalid = undefined; logs.destroy(); control.destroy(); await sim.stop(); sim = new StackSim(options); await sim.start(); domain = sim.opensearch.domain(region, name); logs = new Logs.CloudWatchLogsClient(sdk()); control = new OpenSearch.OpenSearchClient(sdk()); master = new Client({ ...connection, auth: { username: "master", password: "Audit-master-password1!" } });
    assert.deepEqual((await security("GET", "audit")).config, savedConfig); await master.get({ index: "records", id: "acknowledged" });
    await security("PUT", "audit/config", { enabled: false }); const disabledCount = (await events()).length; await master.get({ index: "records", id: "one" }); assert.equal((await events()).length, disabledCount);
    await security("PUT", "audit/config", { enabled: true, audit: { disabled_rest_categories: [] } }); await control.send(new OpenSearch.UpdateDomainConfigCommand({ DomainName: name, LogPublishingOptions: { AUDIT_LOGS: { Enabled: false } } }));
    for (let i = 0; i < 200 && domain.config.LogPublishingOptions.AUDIT_LOGS.Enabled; i++) await delay(10);
    const unpublishedCount = (await events()).length; await master.get({ index: "records", id: "one" }); assert.equal((await events()).length, unpublishedCount);
  } catch (error: any) { throw new Error(`${error.message}: ${JSON.stringify(error.meta?.body ?? {})}`, { cause: error }); }
  finally { await Promise.allSettled([master?.close(), reader?.close(), invalid?.close()]); logs?.destroy(); control?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test("audit configuration rejects unsupported data/transport capture and unsafe or oversized patches", () => {
  for (const input of [{ enabled: null }, { audit: null }, { audit: { enable_rest: 1 } }, { audit: { enable_transport: true } }, { audit: { resolve_bulk_requests: true } }, { audit: { log_request_body: true } }, { audit: { exclude_sensitive_headers: false } }, { compliance: { enabled: true } }, { audit: { disabled_rest_categories: ["INDEX_EVENT"] } }, { audit: { ignore_requests: ["indices:*"] } }, { audit: { ignore_users: Array.from({ length: 101 }, () => "user") } }]) assert.throws(() => validateAudit(input));
  for (const path of ["config/enabled", "/config/__proto__/polluted", "/audit/__proto__", "/unknown"]) assert.throws(() => patchAudit(defaultAudit(), [{ op: "replace", path, value: true }]));
  assert.throws(() => patchAudit(defaultAudit(), [{ op: "remove", path: "/enabled" }]));
  assert.equal(validateAudit({ enabled: true }).audit.enable_rest, true); assert.equal(patchAudit(defaultAudit(), [{ op: "replace", path: "/config/enabled", value: true }]).enabled, true);
});
