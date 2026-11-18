import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { StateStore } from "../src/state.js";
import { TestClock } from "../src/core/clock.js";
import { SearchInsights } from "../src/opensearch/insights.js";
import type { DomainRecord } from "../src/opensearch/model.js";
import { StackSim } from "../src/server.js";
import * as OpenSearch from "@aws-sdk/client-opensearch";
import * as Iam from "@aws-sdk/client-iam";

test("insights persist observed problems, resolve actual recovery and bind pagination/feedback to account and domain", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-insights-")), clock = new TestClock(100000), store = new StateStore(root), region = "eu-west-1", account = store.accountId;
  const domain: DomainRecord = { name: "insight-domain", arn: `arn:aws:es:${region}:${account}:domain/insight-domain`, accountId: account, region, generation: "generation", state: "active", config: { LogPublishingOptions: { ES_APPLICATION_LOGS: { Enabled: true } } }, createdAt: 0, updatedAt: 0, tags: {}, revision: 1, gatewayPort: 0 };
  let metrics: { indexes: number; documentBytes: number } | undefined = { indexes: 80, documentBytes: 54 * 1024 ** 2 };
  const insights = new SearchInsights(store, clock, { domains: (r, a) => r === region && a === account ? [domain] : [], metrics: () => metrics }), entity = { Type: "DomainName", Value: domain.name }, call = (op: string, input: any) => insights.execute(op, input, region, account);
  try {
    await store.load(); store.regionState(region).opensearch.domains[domain.name] = domain;
    await assert.rejects(call("ListInsights", { Entity: entity, TimeRange: { From: 2, To: 1 } }), /TimeRange/); assert.equal(domain.insights, undefined);
    domain.logDeliveryFailures = { ES_APPLICATION_LOGS: { count: 2, at: clock.now(), message: "Resource policy denies delivery" } };
    const first = await call("ListInsights", { Entity: entity, MaxResults: 1, SortOrder: "ASC" }); assert.equal(first.Insights.length, 1); assert.ok(first.NextToken); const second = await call("ListInsights", { Entity: entity, MaxResults: 2, SortOrder: "ASC", NextToken: first.NextToken }); assert.equal(second.Insights.length, 2); assert.notEqual(second.Insights[0].InsightId, first.Insights[0].InsightId);
    await assert.rejects(call("ListInsights", { Entity: { Type: "Account", Value: account }, NextToken: first.NextToken }), /pagination/); await assert.rejects(call("ListInsights", { Entity: { Type: "Account", Value: "111111111111" } }), /caller's account/);
    const event = domain.insights!.find(item => item.key === "log:ES_APPLICATION_LOGS")!;
    assert.equal((await call("DescribeInsightDetails", { Entity: entity, InsightId: event.id })).Fields.find((field: any) => field.Name === "Observation").Value, JSON.stringify({ name: "Failed delivery attempts", value: 2, unit: "Count" }));
    assert.deepEqual(await call("InsightFeedback", { Entity: entity, InsightId: event.id, Thumbs: "Down", FeedbackText: "Resolved the log policy" }), { Status: "SUCCESS" }); assert.equal(event.state, "ACTIVE");
    const save = store.save.bind(store); let fail = true; store.save = async () => { if (fail) { fail = false; throw new Error("Injected feedback save failure"); } await save(); }; await assert.rejects(call("InsightFeedback", { Entity: entity, InsightId: event.id, Thumbs: "Up" }), /Injected/); assert.equal(event.feedback!.thumbs, "Down");
    metrics = undefined; delete domain.logDeliveryFailures.ES_APPLICATION_LOGS; clock.advance(1000); const recovered = await call("ListInsights", { Entity: entity }); assert.equal(recovered.Insights.find((item: any) => item.InsightId === event.id).Status, "RESOLVED"); assert.equal(domain.insights!.find(item => item.key === "index-capacity")!.state, "ACTIVE");
    metrics = { indexes: 1, documentBytes: 30 }; await call("ListInsights", { Entity: entity }); assert.ok(domain.insights!.every(item => item.state === "RESOLVED")); await assert.rejects(call("ListInsights", { Entity: entity, NextToken: first.NextToken, SortOrder: "ASC" }), /stale/);
    assert.equal((await call("ListInsights", { Entity: entity, TimeRange: { From: 100001, To: clock.now() } })).Insights.length, 0);
    domain.state = "failed"; domain.failure = "Missing storage"; await call("ListInsights", { Entity: entity }); assert.equal(domain.insights!.find(item => item.key === "domain")!.priority, "CRITICAL");
    await store.flush(); const reopened = new StateStore(root); await reopened.load(); const saved = reopened.regionState(region).opensearch.domains[domain.name].insights!; assert.equal(saved.find(item => item.id === event.id)!.feedback!.text, "Resolved the log policy");
    for (let i = 0; i < 105; i++) { domain.state = "active"; delete domain.failure; await call("ListInsights", { Entity: entity }); domain.state = "failed"; domain.failure = `Failure ${i}`; clock.advance(1); await call("ListInsights", { Entity: entity }); } assert.equal(domain.insights!.length, 100); assert.equal(domain.insights!.at(-1)!.state, "ACTIVE");
  } finally { await store.flush(); await rm(root, { recursive: true, force: true }); }
});

test("official insight operations observe real index capacity, enforce domain-tag IAM and persist feedback through restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-insight-sdk-")), region = "eu-west-1", options = { dataDir: root, region, port: 0, invokePort: 0, cdkBootstrap: false, authMode: "enforce" as const };
  let sim = new StackSim(options), control: OpenSearch.OpenSearchClient | undefined, iam: Iam.IAMClient | undefined, limited: OpenSearch.OpenSearchClient | undefined;
  const config = () => ({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 });
  try {
    await sim.start(); control = new OpenSearch.OpenSearchClient(config()); iam = new Iam.IAMClient(config()); await control.send(new OpenSearch.CreateDomainCommand({ DomainName: "insight-sdk" })); for (let i = 0; i < 200 && sim.opensearch.domain(region, "insight-sdk").state !== "active"; i++) await delay(10);
    const domain = sim.opensearch.domain(region, "insight-sdk"), engine = (sim.opensearch as any).engine(domain), Entity = { Type: "DomainName" as const, Value: domain.name };
    assert.equal((await control.send(new OpenSearch.ListInsightsCommand({ Entity }))).Insights!.length, 0);
    for (let i = 0; i < 80; i++) await engine.request("PUT", `/records-${i}`, Buffer.from("{}"), "seed");
    const insights = await control.send(new OpenSearch.ListInsightsCommand({ Entity })); assert.equal(insights.Insights!.length, 1); const insight = insights.Insights![0]; assert.equal(insight.Status, "ACTIVE"); assert.equal(insight.IsExperimental, true); assert.ok(insight.CreationTime instanceof Date); assert.ok(Math.abs(insight.CreationTime!.getTime() - Date.now()) < 5000);
    await iam.send(new Iam.CreateUserCommand({ UserName: "insight-reader" })); const key = (await iam.send(new Iam.CreateAccessKeyCommand({ UserName: "insight-reader" }))).AccessKey!; limited = new OpenSearch.OpenSearchClient({ ...config(), credentials: { accessKeyId: key.AccessKeyId!, secretAccessKey: key.SecretAccessKey! } }); await assert.rejects(limited.send(new OpenSearch.ListInsightsCommand({ Entity })), /es:ListInsights/);
    await iam.send(new Iam.PutUserPolicyCommand({ UserName: "insight-reader", PolicyName: "Domain", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["es:ListInsights", "es:DescribeInsightDetails"], Resource: domain.arn, Condition: { StringEquals: { "aws:ResourceTag/Team": "search" } } }] }) })); await assert.rejects(limited.send(new OpenSearch.ListInsightsCommand({ Entity })), /es:ListInsights/); await control.send(new OpenSearch.AddTagsCommand({ ARN: domain.arn, TagList: [{ Key: "Team", Value: "search" }] }));
    assert.equal((await limited.send(new OpenSearch.ListInsightsCommand({ Entity }))).Insights![0].InsightId, insight.InsightId); await assert.rejects(limited.send(new OpenSearch.ListInsightsCommand({ Entity: { Type: "Account" } })), /es:ListInsights/); await assert.rejects(limited.send(new OpenSearch.InsightFeedbackCommand({ Entity, InsightId: insight.InsightId!, Thumbs: "Up" })), /es:InsightFeedback/);
    assert.equal((await limited.send(new OpenSearch.DescribeInsightDetailsCommand({ Entity, InsightId: insight.InsightId!, ShowHtmlContent: false }))).Fields!.find(field => field.Name === "Observation")!.Value, JSON.stringify({ name: "Indexes", value: 80, unit: "Count" }));
    await control.send(new OpenSearch.InsightFeedbackCommand({ Entity, InsightId: insight.InsightId!, Thumbs: "Up", FeedbackText: "Capacity guidance was useful" })); await engine.request("DELETE", "/records-0", Buffer.alloc(0), "seed"); assert.equal((await control.send(new OpenSearch.ListInsightsCommand({ Entity }))).Insights![0].Status, "RESOLVED");
    control.destroy(); iam.destroy(); limited.destroy(); await sim.stop(); sim = new StackSim(options); await sim.start(); control = new OpenSearch.OpenSearchClient(config()); assert.match((await control.send(new OpenSearch.DescribeInsightDetailsCommand({ Entity, InsightId: insight.InsightId! }))).Fields!.find(field => field.Name === "Feedback")!.Value!, /Capacity guidance was useful/);
  } finally { control?.destroy(); iam?.destroy(); limited?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
