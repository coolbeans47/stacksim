import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import * as Logs from "@aws-sdk/client-cloudwatch-logs";
import * as OpenSearch from "@aws-sdk/client-opensearch";
import * as Cfn from "@aws-sdk/client-cloudformation";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { StackSim } from "../src/server.js";
import { domainArn } from "../src/opensearch/model.js";
import { SearchError } from "../src/opensearch/query.js";

test("log publishing validates service resource policies and emits measured threshold events without source data", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-search-logs-")), region = "eu-west-1", credentials = { accessKeyId: "admin", secretAccessKey: "password" }, sim = new StackSim({ dataDir: root, port: 0, invokePort: 0, authMode: "enforce", cdkBootstrap: false });
  let control: OpenSearch.OpenSearchClient | undefined, logs: Logs.CloudWatchLogsClient | undefined, search: Client | undefined;
  try {
    await sim.start(); const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }; control = new OpenSearch.OpenSearchClient(sdk); logs = new Logs.CloudWatchLogsClient(sdk);
    const account = sim.store.accountId, arn = domainArn(region, account, "logged-domain"), group = "/aws/opensearch/test", groupArn = `arn:aws:logs:${region}:${account}:log-group:${group}`;
    await logs.send(new Logs.CreateLogGroupCommand({ logGroupName: group }));
    const publishing = { SEARCH_SLOW_LOGS: { Enabled: true, CloudWatchLogsLogGroupArn: groupArn }, INDEX_SLOW_LOGS: { Enabled: true, CloudWatchLogsLogGroupArn: groupArn }, ES_APPLICATION_LOGS: { Enabled: true, CloudWatchLogsLogGroupArn: groupArn } };
    await assert.rejects(control.send(new OpenSearch.CreateDomainCommand({ DomainName: "logged-domain", LogPublishingOptions: publishing })), { name: "ValidationException" }); assert.equal(sim.opensearch.domains(region).length, 0);
    const policy = (effect = "Allow", source = arn) => JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: effect, Principal: { Service: "es.amazonaws.com" }, Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: `${groupArn}:*`, Condition: { ArnEquals: { "aws:SourceArn": source }, StringEquals: { "aws:SourceAccount": account } } }] });
    await logs.send(new Logs.PutResourcePolicyCommand({ policyName: "search", policyDocument: policy("Allow", arn + "wrong") }));
    await assert.rejects(control.send(new OpenSearch.CreateDomainCommand({ DomainName: "logged-domain", LogPublishingOptions: publishing })), { name: "ValidationException" });
    await logs.send(new Logs.PutResourcePolicyCommand({ policyName: "search", policyDocument: policy() }));
    await control.send(new OpenSearch.CreateDomainCommand({ DomainName: "logged-domain", LogPublishingOptions: publishing, EncryptionAtRestOptions: { Enabled: true } }));
    for (let i = 0; i < 200 && sim.opensearch.domain(region, "logged-domain").state !== "active"; i++) await delay(10);
    const domain = sim.opensearch.domain(region, "logged-domain"), ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath);
    search = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca }, maxRetries: 0, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => credentials }) });
    const events = async (type: string) => {
      const result = await logs!.send(new Logs.FilterLogEventsCommand({ logGroupName: group, logStreamNamePrefix: `opensearch/${domain.generation}/${type}` })); return (result.events ?? []).map(event => JSON.parse(event.message!));
    };
    await search.index({ index: "records", id: "one", body: { value: "must-not-appear-in-logs-456d" } });
    assert.equal((await events("INDEX_SLOW_LOGS")).length, 0);
    await search.indices.putSettings({ index: "records", body: { "index.indexing.slowlog.threshold.index.warn": "0ms", "index.search.slowlog.threshold.query.info": "0ms" } });
    await search.index({ index: "records", id: "two", refresh: true, body: { value: "must-not-appear-in-logs-456d" } });
    await search.search({ index: "records", body: { query: { match_all: {} } } });
    const writes = await events("INDEX_SLOW_LOGS"), reads = await events("SEARCH_SLOW_LOGS"); assert.equal(writes.length, 1); assert.equal(reads.length, 1); assert.equal(writes[0].level, "WARN"); assert.equal(reads[0].level, "INFO"); assert.ok(writes[0].took_millis >= 0); assert.ok(Number.isFinite(reads[0].took_millis));
    assert.equal(writes[0].index, "records"); assert.ok(!JSON.stringify([...writes, ...reads, ...await events("ES_APPLICATION_LOGS")]).includes("must-not-appear"));
    const engine = (sim.opensearch as any).engine(domain), request = engine.request.bind(engine);
    engine.request = async () => { throw new SearchError("unavailable_shards_exception", "Injected storage outage with private details", 503); };
    try { await assert.rejects(search.cluster.health(), (error: any) => error.statusCode === 503); } finally { engine.request = request; }
    const failures = (await events("ES_APPLICATION_LOGS")).filter(event => event.event === "request_failed"); assert.equal(failures.length, 1); assert.equal(failures[0].status, 503); assert.ok(!JSON.stringify(failures).includes("private details"));
    await logs.send(new Logs.PutResourcePolicyCommand({ policyName: "deny-search", policyDocument: policy("Deny") }));
    await search.index({ index: "records", id: "three", body: { value: "acknowledged-despite-log-denial" } });
    assert.equal((await search.get({ index: "records", id: "three" })).body._source.value, "acknowledged-despite-log-denial"); assert.ok(domain.logDeliveryFailures?.INDEX_SLOW_LOGS.count);
    assert.equal((await events("INDEX_SLOW_LOGS")).length, 1);
    await assert.rejects(control.send(new OpenSearch.UpdateDomainConfigCommand({ DomainName: domain.name, LogPublishingOptions: publishing })), { name: "ValidationException" });
    await logs.send(new Logs.DeleteResourcePolicyCommand({ policyName: "deny-search" }));
    await search.index({ index: "records", id: "four", body: { value: "recovered" } }); assert.equal(domain.logDeliveryFailures?.INDEX_SLOW_LOGS, undefined); assert.equal((await events("INDEX_SLOW_LOGS")).length, 2);
    await search.indices.putSettings({ index: "records", body: { "index.search.slowlog.threshold.query.info": "-1" } }); await search.search({ index: "records", body: { query: { match_all: {} } } }); assert.equal((await events("SEARCH_SLOW_LOGS")).length, 1);
    await assert.rejects(search.indices.putSettings({ index: "records", body: { "index.search.slowlog.threshold.query.warn": "-2ms" } }), /threshold/);
    await assert.rejects(control.send(new OpenSearch.UpdateDomainConfigCommand({ DomainName: domain.name, LogPublishingOptions: { AUDIT_LOGS: { Enabled: true, CloudWatchLogsLogGroupArn: groupArn } } })), { name: "ValidationException" });
    await control.send(new OpenSearch.UpdateDomainConfigCommand({ DomainName: domain.name, LogPublishingOptions: { INDEX_SLOW_LOGS: { Enabled: false } } }));
    await search.index({ index: "records", id: "five", body: {} }); assert.equal((await events("INDEX_SLOW_LOGS")).length, 2);
  } finally { await search?.close(); control?.destroy(); logs?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test("CloudFormation domain logging uses live log groups and policies through create, update and cleanup", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-search-logs-cfn-")), region = "eu-west-1", credentials = { accessKeyId: "admin", secretAccessKey: "password" }, sim = new StackSim({ dataDir: root, port: 0, invokePort: 0, authMode: "enforce", cdkBootstrap: false });
  let cfn: Cfn.CloudFormationClient | undefined, logs: Logs.CloudWatchLogsClient | undefined, search: Client | undefined;
  try {
    await sim.start(); const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }; cfn = new Cfn.CloudFormationClient(sdk); logs = new Logs.CloudWatchLogsClient(sdk);
    const group = "/aws/opensearch/cfn", groupArn = `arn:aws:logs:${region}:${sim.store.accountId}:log-group:${group}`, arn = domainArn(region, sim.store.accountId, "cfn-log-domain");
    const template = (enabled: boolean) => JSON.stringify({ Resources: {
      Group: { Type: "AWS::Logs::LogGroup", Properties: { LogGroupName: group } },
      Policy: { Type: "AWS::Logs::ResourcePolicy", DependsOn: "Group", Properties: { PolicyName: "search-cfn", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "es.amazonaws.com" }, Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: `${groupArn}:*`, Condition: { ArnEquals: { "aws:SourceArn": arn } } }] }) } },
      Domain: { Type: "AWS::OpenSearchService::Domain", DependsOn: "Policy", Properties: { DomainName: "cfn-log-domain", EncryptionAtRestOptions: { Enabled: true }, NodeToNodeEncryptionOptions: { Enabled: true }, AdvancedSecurityOptions: { Enabled: true, MasterUserOptions: { MasterUserARN: `arn:aws:iam::${sim.store.accountId}:user/admin` } }, LogPublishingOptions: { INDEX_SLOW_LOGS: { Enabled: enabled, CloudWatchLogsLogGroupArn: groupArn }, AUDIT_LOGS: { Enabled: enabled, CloudWatchLogsLogGroupArn: groupArn } } } },
    } });
    let stackId = "search-logs";
    const wait = async (status: string) => { for (let i = 0; i < 200; i++) { const stack = (await cfn!.send(new Cfn.DescribeStacksCommand({ StackName: stackId }))).Stacks![0]; if (stack.StackStatus === status) return; if (stack.StackStatus?.includes("FAILED") || stack.StackStatus?.includes("ROLLBACK_COMPLETE")) throw new Error(`${stack.StackStatus}: ${stack.StackStatusReason}`); await delay(20); } throw new Error(`Stack did not reach ${status}`); };
    stackId = (await cfn.send(new Cfn.CreateStackCommand({ StackName: "search-logs", TemplateBody: template(true) }))).StackId!; await wait("CREATE_COMPLETE");
    const domain = sim.opensearch.domain(region, "cfn-log-domain"), ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath);
    search = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => credentials }) });
    const events = async (type: string) => (await logs!.send(new Logs.FilterLogEventsCommand({ logGroupName: group, logStreamNamePrefix: `opensearch/${domain.generation}/${type}` }))).events ?? [];
    await search.transport.request({ method: "PUT", path: "/_plugins/_security/api/audit/config", body: { enabled: true, audit: { disabled_rest_categories: [] } } });
    await search.indices.create({ index: "records", body: { settings: { "index.indexing.slowlog.threshold.index.warn": "0ms" } } }); await search.index({ index: "records", id: "one", body: { value: "cfn-logged" } });
    assert.equal((await events("INDEX_SLOW_LOGS")).length, 1); const auditCount = (await events("AUDIT_LOGS")).length; assert.ok(auditCount > 0);
    await cfn.send(new Cfn.UpdateStackCommand({ StackName: "search-logs", TemplateBody: template(false) })); await wait("UPDATE_COMPLETE");
    await search.index({ index: "records", id: "two", body: {} }); assert.equal((await events("INDEX_SLOW_LOGS")).length, 1); assert.equal((await events("AUDIT_LOGS")).length, auditCount);
    await search.close(); search = undefined; await cfn.send(new Cfn.DeleteStackCommand({ StackName: "search-logs" })); await wait("DELETE_COMPLETE");
    assert.equal(sim.opensearch.domains(region).length, 0); assert.equal((await logs.send(new Logs.DescribeLogGroupsCommand({ logGroupNamePrefix: group }))).logGroups?.length, 0);
  } finally { await search?.close(); cfn?.destroy(); logs?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
