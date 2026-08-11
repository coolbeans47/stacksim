import assert from "node:assert/strict";
import { appendFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  CreateArchiveCommand,
  CreateEventBusCommand,
  DeleteEventBusCommand,
  DeleteRuleCommand,
  DescribeEventBusCommand,
  DescribeReplayCommand,
  DescribeRuleCommand,
  DisableRuleCommand,
  EnableRuleCommand,
  EventBridgeClient,
  ListEventBusesCommand,
  ListRuleNamesByTargetCommand,
  ListRulesCommand,
  ListTagsForResourceCommand,
  ListTargetsByRuleCommand,
  PutEventsCommand,
  PutRuleCommand,
  PutTargetsCommand,
  RemoveTargetsCommand,
  StartReplayCommand,
  TagResourceCommand,
  TestEventPatternCommand,
  UntagResourceCommand,
} from "@aws-sdk/client-eventbridge";
import { AttachRolePolicyCommand, CreatePolicyCommand, CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { AddPermissionCommand, CreateAliasCommand, CreateFunctionCommand, InvokeCommand, LambdaClient, PublishVersionCommand } from "@aws-sdk/client-lambda";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const account = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const active: Array<{ simulator: StackSim; root: string; clients: Array<{ destroy(): void }> }> = [];

async function harness(options: { clock?: TestClock; authMode?: "off" | "enforce" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "stacksim-eventbridge-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock: options.clock, authMode: options.authMode ?? "off", cdkBootstrap: true });
  await simulator.start();
  const endpoint = `http://127.0.0.1:${simulator.port}`;
  const client = new EventBridgeClient({ endpoint, region, credentials });
  const clients: Array<{ destroy(): void }> = [client]; active.push({ simulator, root, clients });
  return { root, simulator, endpoint, client, clients };
}

afterEach(async () => {
  while (active.length) {
    const item = active.pop()!; for (const client of item.clients) client.destroy();
    await item.simulator.stop().catch(() => undefined); await rm(item.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error("Timed out waiting for EventBridge worker"); await new Promise(resolve => setTimeout(resolve, 5)); }
}

async function driveClockUntil(clock: TestClock, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    clock.advance(0);
    if (Date.now() >= deadline) throw new Error("Timed out driving the EventBridge test clock");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("official EventBridge client covers buses, pattern rules, targets, tags, and pagination", async () => {
  const h = await harness();
  const initial = await h.client.send(new ListEventBusesCommand({}));
  assert.deepEqual(initial.EventBuses?.map(bus => bus.Name), ["default"]);
  assert.match((await h.client.send(new DescribeEventBusCommand({}))).Arn!, /event-bus\/default$/);

  const created = await h.client.send(new CreateEventBusCommand({ Name: "orders", Description: "Order events", Tags: [{ Key: "environment", Value: "dev" }] }));
  assert.equal(created.EventBusArn, `arn:aws:events:${region}:${account}:event-bus/orders`);
  assert.equal(created.Description, "Order events");
  await assert.rejects(h.client.send(new CreateEventBusCommand({ Name: "custom/with-slash" })), (error: any) => error.name === "ValidationException");
  const described = await h.client.send(new DescribeEventBusCommand({ Name: created.EventBusArn }));
  assert.equal(described.Description, "Order events"); assert(described.CreationTime instanceof Date);
  await h.client.send(new TagResourceCommand({ ResourceARN: created.EventBusArn!, Tags: [{ Key: "owner", Value: "local" }] }));
  await h.client.send(new UntagResourceCommand({ ResourceARN: created.EventBusArn!, TagKeys: ["environment"] }));
  assert.deepEqual((await h.client.send(new ListTagsForResourceCommand({ ResourceARN: created.EventBusArn! }))).Tags, [{ Key: "owner", Value: "local" }]);

  await h.client.send(new CreateEventBusCommand({ Name: "orders-archive" }));
  const firstBusPage = await h.client.send(new ListEventBusesCommand({ NamePrefix: "orders", Limit: 1 })); assert.equal(firstBusPage.EventBuses?.length, 1); assert(firstBusPage.NextToken);
  const secondBusPage = await h.client.send(new ListEventBusesCommand({ NamePrefix: "orders", Limit: 1, NextToken: firstBusPage.NextToken })); assert.equal(secondBusPage.EventBuses?.length, 1); assert.notEqual(secondBusPage.EventBuses?.[0].Name, firstBusPage.EventBuses?.[0].Name);

  const pattern = JSON.stringify({ source: ["com.example.orders"], detail: { state: ["created"] } });
  const rule = await h.client.send(new PutRuleCommand({ Name: "created-orders", EventBusName: "orders", EventPattern: pattern, Description: "first version", Tags: [{ Key: "team", Value: "checkout" }] }));
  assert.equal(rule.RuleArn, `arn:aws:events:${region}:${account}:rule/orders/created-orders`);
  assert.equal((await h.client.send(new DescribeRuleCommand({ Name: "created-orders", EventBusName: "orders" }))).Description, "first version");
  await h.client.send(new PutRuleCommand({ Name: "created-orders", EventBusName: "orders", EventPattern: pattern, State: "DISABLED", Tags: [{ Key: "ignored", Value: "true" }] }));
  const replaced = await h.client.send(new DescribeRuleCommand({ Name: "created-orders", EventBusName: "orders" })); assert.equal(replaced.Description, undefined); assert.equal(replaced.State, "DISABLED");
  assert.deepEqual((await h.client.send(new ListTagsForResourceCommand({ ResourceARN: rule.RuleArn! }))).Tags, [{ Key: "team", Value: "checkout" }], "PutRule ignores Tags when replacing an existing rule");
  await h.client.send(new EnableRuleCommand({ Name: "created-orders", EventBusName: "orders" })); await h.client.send(new DisableRuleCommand({ Name: "created-orders", EventBusName: "orders" }));

  await h.client.send(new PutRuleCommand({ Name: "created-orders-two", EventBusName: "orders", EventPattern: pattern }));
  const firstRulePage = await h.client.send(new ListRulesCommand({ EventBusName: "orders", NamePrefix: "created", Limit: 1 })); assert.equal(firstRulePage.Rules?.length, 1); assert(firstRulePage.NextToken);
  assert.equal((await h.client.send(new ListRulesCommand({ EventBusName: "orders", NamePrefix: "created", Limit: 1, NextToken: firstRulePage.NextToken }))).Rules?.length, 1);

  const functionArn = `arn:aws:lambda:${region}:${account}:function:event-handler:live`;
  const targetResult = await h.client.send(new PutTargetsCommand({ Rule: "created-orders", EventBusName: "orders", Targets: [{ Id: "lambda", Arn: functionArn, InputTransformer: { InputPathsMap: { orderId: "$.detail.id" }, InputTemplate: "{\"orderId\":<orderId>,\"rule\":<aws.events.rule-name>}" }, RetryPolicy: { MaximumEventAgeInSeconds: 60, MaximumRetryAttempts: 2 } }] }));
  assert.equal(targetResult.FailedEntryCount, 0);
  const target = (await h.client.send(new ListTargetsByRuleCommand({ Rule: "created-orders", EventBusName: "orders" }))).Targets?.[0]!; assert.equal(target.Id, "lambda"); assert.equal(target.RetryPolicy?.MaximumRetryAttempts, 2); assert.equal(target.InputTransformer?.InputPathsMap?.orderId, "$.detail.id");
  const transformerEdges = await h.client.send(new PutTargetsCommand({ Rule: "created-orders", EventBusName: "orders", Targets: [
    { Id: "awesome-key", Arn: functionArn, InputTransformer: { InputPathsMap: { awesome: "$.detail.id" }, InputTemplate: "order <awesome>" } },
    { Id: "embedded-object-key", Arn: functionArn, InputTransformer: { InputPathsMap: { id: "$.detail.id" }, InputTemplate: '{"prefix-<id>":true}' } },
  ] }));
  assert.equal(transformerEdges.FailedEntryCount, 1); assert.equal(transformerEdges.FailedEntries?.[0].TargetId, "embedded-object-key");
  assert.deepEqual((await h.client.send(new ListRuleNamesByTargetCommand({ TargetArn: functionArn, EventBusName: "orders" }))).RuleNames, ["created-orders"]);
  await assert.rejects(h.client.send(new DeleteRuleCommand({ Name: "created-orders", EventBusName: "orders" })), (error: any) => error.name === "ValidationException");
  assert.equal((await h.client.send(new RemoveTargetsCommand({ Rule: "created-orders", EventBusName: "orders", Ids: ["lambda", "awesome-key"] }))).FailedEntryCount, 0);

  await assert.rejects(h.client.send(new DeleteEventBusCommand({ Name: "orders" })), (error: any) => error.name === "ValidationException");
  await h.client.send(new DeleteRuleCommand({ Name: "created-orders", EventBusName: "orders" })); await h.client.send(new DeleteRuleCommand({ Name: "created-orders", EventBusName: "orders" })); await h.client.send(new DeleteRuleCommand({ Name: "created-orders-two", EventBusName: "orders" }));
  await h.client.send(new DeleteEventBusCommand({ Name: "orders" })); await h.client.send(new DeleteEventBusCommand({ Name: "orders" })); await h.client.send(new DeleteEventBusCommand({ Name: "orders-archive" }));
  await assert.rejects(h.client.send(new DeleteEventBusCommand({ Name: "default" })), (error: any) => error.name === "ValidationException");
});

test("PutEvents preserves ordered partial results, missing-bus success, pattern equivalence, transformation, and JSON 1.1 headers", async () => {
  const h = await harness(); const deliveries: Array<{ arn: string; payload: any; principal: string; sourceArn: string }> = [];
  (h.simulator.lambda as any).enqueueServiceInvocation = async (arn: string, payload: Buffer, principal: string, sourceArn: string) => { deliveries.push({ arn, payload: JSON.parse(payload.toString("utf8")), principal, sourceArn }); return `accepted-${deliveries.length}`; };
  await h.client.send(new CreateEventBusCommand({ Name: "application" }));
  const pattern = JSON.stringify({ source: [{ prefix: "com.example." }], "detail-type": ["Order changed"], detail: { state: ["created"], amount: [{ numeric: [">=", 10] }] } });
  assert.equal((await h.client.send(new TestEventPatternCommand({ EventPattern: pattern, Event: JSON.stringify({ version: "0", id: "sample", account, source: "com.example.orders", time: "2026-07-20T12:00:00Z", region, resources: [], "detail-type": "Order changed", detail: { state: "created", amount: 25 } }) }))).Result, true);
  await h.client.send(new PutRuleCommand({ Name: "route-orders", EventBusName: "application", EventPattern: pattern }));
  const lambdaArn = `arn:aws:lambda:${region}:${account}:function:orders-handler`;
  const targets = await h.client.send(new PutTargetsCommand({ Rule: "route-orders", EventBusName: "application", Targets: [
    { Id: "raw", Arn: lambdaArn },
    { Id: "constant", Arn: lambdaArn, Input: "{\"constant\":true}" },
    { Id: "detail", Arn: lambdaArn, InputPath: "$.detail" },
    { Id: "transform", Arn: lambdaArn, InputTransformer: { InputPathsMap: { id: "$.detail.id", missing: "$.detail.notPresent" }, InputTemplate: "{\"id\":<id>,\"message\":\"order <id> <missing>\",\"missing\":<missing>,\"rule\":<aws.events.rule-name>,\"event\":<aws.events.event>,\"full\":<aws.events.event.json>}" } },
    { Id: "missing", Arn: lambdaArn, InputPath: "$.detail.notPresent" },
  ] })); assert.equal(targets.FailedEntryCount, 0);

  const output = await h.client.send(new PutEventsCommand({ Entries: [
    { EventBusName: "application", Source: "com.example.orders", DetailType: "Order changed", Detail: JSON.stringify({ id: "o-1", state: "created", amount: 25 }) },
    { EventBusName: "does-not-exist", Source: "com.example.orders", DetailType: "Order changed", Detail: "{}" },
    { EventBusName: "application", Source: "com.example.orders", DetailType: "Order changed", Detail: "not-json" },
  ] }));
  assert.equal(output.FailedEntryCount, 1); assert.match(output.Entries?.[0].EventId ?? "", /^[0-9a-f-]{36}$/); assert.match(output.Entries?.[1].EventId ?? "", /^[0-9a-f-]{36}$/); assert.equal(output.Entries?.[2].ErrorCode, "MalformedDetail");
  await waitUntil(() => deliveries.length === 5);
  assert.equal(deliveries.every(item => item.principal === "events.amazonaws.com" && item.sourceArn.endsWith("rule/application/route-orders")), true);
  assert.equal(deliveries.some(item => item.payload?.detail?.id === "o-1"), true); assert.equal(deliveries.some(item => item.payload?.constant === true), true); assert.equal(deliveries.some(item => item.payload?.state === "created"), true); const transformed = deliveries.find(item => item.payload?.rule === "route-orders")!.payload; assert.equal(transformed.message, "order o-1 "); assert.equal("missing" in transformed, false); assert.equal("detail" in transformed.event, false); assert.equal(transformed.full.detail.id, "o-1"); assert.equal(deliveries.some(item => item.payload === null), true);

  const raw = await fetch(h.endpoint, { method: "POST", headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSEvents.PutEvents" }, body: JSON.stringify({ Entries: [{ EventBusName: "missing-raw", Source: "raw.test", DetailType: "Raw", Detail: "{}" }] }) });
  assert.equal(raw.status, 200); assert.match(raw.headers.get("content-type") ?? "", /application\/x-amz-json-1\.1/); assert(raw.headers.get("x-amzn-requestid")); const rawBody = await raw.json() as any; assert.equal(rawBody.FailedEntryCount, 0); assert(rawBody.Entries[0].EventId);
  await assert.rejects(h.client.send(new PutEventsCommand({ Entries: [{ Source: "incomplete" }] })), (error: any) => error.name === "ValidationException");
  assert.equal((await readFile(join(h.root, "state.json"), "utf8")).includes("o-1"), false, "ordinary accepted event payloads stay outside control state");
  await Promise.allSettled([...(h.simulator.eventbridge as any).pendingTelemetry]);
  const listedMetrics = await h.simulator.metrics.ListMetrics({ Namespace: "AWS/Events" }); const metricNames = new Set(listedMetrics.Metrics.map((metric: any) => metric.MetricName));
  for (const name of ["PutEventsApproximateCallCount", "PutEventsApproximateSuccessCount", "PutEventsApproximateFailedCount", "PutEventsLatency", "MatchedEvents", "TriggeredRules", "Invocations", "InvocationAttempts", "SuccessfulInvocationAttempts", "IngestiontoInvocationStartLatency", "IngestiontoInvocationCompleteLatency", "IngestionToInvocationSuccessLatency"]) assert(metricNames.has(name), `missing AWS/Events metric ${name}`);
  const hasDimensions = (name: string, expected: Record<string, string>) => listedMetrics.Metrics.some((metric: any) => metric.MetricName === name && JSON.stringify(Object.fromEntries((metric.Dimensions ?? []).map((dimension: any) => [dimension.Name, dimension.Value]).sort(([a]: [string], [b]: [string]) => a.localeCompare(b)))) === JSON.stringify(Object.fromEntries(Object.entries(expected).sort(([a], [b]) => a.localeCompare(b)))));
  assert.equal(hasDimensions("MatchedEvents", { EventBusName: "application" }), true); assert.equal(hasDimensions("MatchedEvents", { EventBusName: "application", RuleName: "route-orders" }), true);
  assert.equal(hasDimensions("InvocationAttempts", {}), true); assert.equal(hasDimensions("InvocationAttempts", { EventBusName: "application" }), true); assert.equal(hasDimensions("InvocationAttempts", { EventBusName: "application", RuleName: "route-orders" }), true);
  assert.equal(hasDimensions("Invocations", {}), true); assert.equal(hasDimensions("Invocations", { EventBusName: "application" }), false); assert.equal(hasDimensions("Invocations", { EventBusName: "application", RuleName: "route-orders" }), true);
  assert.equal(listedMetrics.Metrics.every((metric: any) => !(metric.Dimensions ?? []).some((dimension: any) => dimension.Name === "TargetId" || dimension.Name === "TargetArn")), true, "EventBridge metrics must not invent target dimensions");
});

test("PutEvents preserves JSON number tokens and enforces the aggregate entry-size limit", async () => {
  const h = await harness(); const payloads: string[] = [];
  (h.simulator.lambda as any).enqueueServiceInvocation = async (_arn: string, payload: Buffer) => { payloads.push(payload.toString("utf8")); return "accepted"; };
  await h.client.send(new PutRuleCommand({ Name: "lossless-rule", EventPattern: JSON.stringify({ source: ["lossless.test"] }) }));
  const arn = `arn:aws:lambda:${region}:${account}:function:lossless-target`;
  await h.client.send(new PutTargetsCommand({ Rule: "lossless-rule", Targets: [
    { Id: "full", Arn: arn },
    { Id: "detail", Arn: arn, InputPath: "$.detail" },
    { Id: "transform", Arn: arn, InputTransformer: { InputPathsMap: { large: "$.detail.large", decimal: "$.detail.decimal", scientific: "$.detail.scientific" }, InputTemplate: '{"kind":"transform","large":<large>,"decimal":<decimal>,"scientific":<scientific>}' } },
  ] }));
  const detail = '{"large":9223372036854775807,"decimal":300.0,"scientific":3e2}';
  const accepted = await h.client.send(new PutEventsCommand({ Entries: [{ Source: "lossless.test", DetailType: "Numbers", Detail: detail }] })); assert.equal(accepted.FailedEntryCount, 0);
  await waitUntil(() => payloads.length === 3);
  assert(payloads.some(payload => payload.includes(`"detail":${detail}`))); assert(payloads.includes(detail)); assert(payloads.includes('{"kind":"transform","large":9223372036854775807,"decimal":300.0,"scientific":3e2}'));

  const invalidInteger = await h.client.send(new PutEventsCommand({ Entries: [{ Source: "lossless.test", DetailType: "Numbers", Detail: '{"large":9223372036854775808}' }] }));
  assert.equal(invalidInteger.Entries?.[0].ErrorCode, "InvalidArgument");

  const source = "size.test"; const detailType = "Boundary"; const wrapperBytes = Buffer.byteLength('{"blob":""}'); const fixedBytes = Buffer.byteLength(source) + Buffer.byteLength(detailType) + wrapperBytes;
  const nearLimit = `{"blob":"${"x".repeat(1024 * 1024 - 1 - fixedBytes)}"}`;
  assert.equal(Buffer.byteLength(source) + Buffer.byteLength(detailType) + Buffer.byteLength(nearLimit), 1024 * 1024 - 1);
  assert.equal((await h.client.send(new PutEventsCommand({ Entries: [{ EventBusName: "missing-size-bus", Source: source, DetailType: detailType, Detail: nearLimit }] }))).FailedEntryCount, 0);
  const atLimit = `{"blob":"${"x".repeat(1024 * 1024 - fixedBytes)}"}`;
  await assert.rejects(h.client.send(new PutEventsCommand({ Entries: [{ EventBusName: "missing-size-bus", Source: source, DetailType: detailType, Detail: atLimit }] })), (error: any) => error.name === "ValidationException");
});

test("matching honors unmatched, disabled, multiple-rule, five-target, and accepted target-snapshot behavior", async () => {
  const clock = new TestClock(1_700_000_000_000); const h = await harness({ clock }); const calls: Array<{ arn: string; payload: any }> = [];
  (h.simulator.lambda as any).enqueueServiceInvocation = async (arn: string, payload: Buffer) => { calls.push({ arn, payload: JSON.parse(payload.toString("utf8")) }); return `accepted-${calls.length}`; };
  const pattern = JSON.stringify({ source: ["fanout.test"] });
  await h.client.send(new PutRuleCommand({ Name: "five-targets", EventPattern: pattern }));
  await h.client.send(new PutRuleCommand({ Name: "second-rule", EventPattern: pattern }));
  const five = Array.from({ length: 5 }, (_, index) => ({ Id: `target-${index}`, Arn: `arn:aws:lambda:${region}:${account}:function:fanout-${index}${index === 1 ? ":live" : index === 2 ? ":42" : ""}` }));
  assert.equal((await h.client.send(new PutTargetsCommand({ Rule: "five-targets", Targets: five }))).FailedEntryCount, 0);
  const secondArn = `arn:aws:lambda:${region}:${account}:function:second-target`;
  await h.client.send(new PutTargetsCommand({ Rule: "second-rule", Targets: [{ Id: "second", Arn: secondArn }] }));
  await h.client.send(new DisableRuleCommand({ Name: "second-rule" }));

  await h.client.send(new PutEventsCommand({ Entries: [
    { Source: "unmatched.test", DetailType: "Ignored", Detail: "{}" },
    { Source: "fanout.test", DetailType: "Matched", Detail: "{\"sequence\":1}" },
  ] }));
  assert.equal(h.simulator.eventbridge.deliveryDiagnostics().queued, 5);
  await driveClockUntil(clock, () => calls.length === 5);
  assert.equal(calls.length, 5); assert.deepEqual(new Set(calls.map(call => call.arn)), new Set(five.map(target => target.Arn)));

  await h.client.send(new EnableRuleCommand({ Name: "second-rule" }));
  await h.client.send(new PutEventsCommand({ Entries: [{ Source: "fanout.test", DetailType: "Matched", Detail: "{\"sequence\":2}" }] }));
  assert.equal(h.simulator.eventbridge.deliveryDiagnostics().queued, 6);
  await h.client.send(new RemoveTargetsCommand({ Rule: "second-rule", Ids: ["second"] })); await h.client.send(new DeleteRuleCommand({ Name: "second-rule" }));
  await driveClockUntil(clock, () => calls.length === 11);
  assert.equal(calls.length, 11); assert.equal(calls.filter(call => call.arn === secondArn).length, 1, "accepted target snapshots survive later rule deletion");

  await h.client.send(new DisableRuleCommand({ Name: "five-targets" }));
  await h.client.send(new PutEventsCommand({ Entries: [{ Source: "fanout.test", DetailType: "Disabled", Detail: "{}" }] })); clock.advance(0); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls.length, 11);
});

test("target transformation failures are isolated from accepted sibling deliveries", async () => {
  const clock = new TestClock(1_700_000_000_000); const h = await harness({ clock }); const delivered: any[] = [];
  (h.simulator.lambda as any).enqueueServiceInvocation = async (_arn: string, payload: Buffer) => { delivered.push(JSON.parse(payload.toString("utf8"))); return "accepted"; };
  await h.client.send(new PutRuleCommand({ Name: "independent-targets", EventPattern: JSON.stringify({ source: ["transform.test"] }) }));
  const arn = `arn:aws:lambda:${region}:${account}:function:transform-target`;
  await h.client.send(new PutTargetsCommand({ Rule: "independent-targets", Targets: [
    { Id: "raw", Arn: arn },
    { Id: "oversized", Arn: arn, InputTransformer: { InputPathsMap: { value: "$.detail.value" }, InputTemplate: "{\"first\":<value>,\"second\":<value>}" } },
  ] }));
  const output = await h.client.send(new PutEventsCommand({ Entries: [{ Source: "transform.test", DetailType: "Large", Detail: JSON.stringify({ value: "x".repeat(540_000) }) }] }));
  assert.equal(output.FailedEntryCount, 0); assert.equal(h.simulator.eventbridge.deliveryDiagnostics().queued, 1); assert.equal(h.simulator.eventbridge.deliveryDiagnostics().failed, 1);
  await driveClockUntil(clock, () => delivered.length === 1);
  assert.equal(delivered.length, 1); assert.equal(delivered[0].detail.value.length, 540_000);
});

test("retry ambiguity permits duplicates while maximum event age prevents stale handoff", async () => {
  const clock = new TestClock(1_700_000_000_000); const h = await harness({ clock }); const acceptedPayloads: any[] = []; let attempts = 0;
  (h.simulator.lambda as any).enqueueServiceInvocation = async (_arn: string, payload: Buffer) => { attempts++; acceptedPayloads.push(JSON.parse(payload.toString("utf8"))); return "accepted"; };
  const deliveryStore = (h.simulator.eventbridge as any).deliveries; const originalRecord = deliveryStore.record.bind(deliveryStore); let failCheckpoint = true;
  deliveryStore.record = async (diagnostic: any) => { if (diagnostic.status === "SUCCEEDED" && failCheckpoint) { failCheckpoint = false; throw new Error("sensitive downstream text"); } return originalRecord(diagnostic); };
  await h.client.send(new PutRuleCommand({ Name: "duplicate-rule", EventPattern: JSON.stringify({ source: ["duplicate.test"] }) }));
  await h.client.send(new PutTargetsCommand({ Rule: "duplicate-rule", Targets: [{ Id: "lambda", Arn: `arn:aws:lambda:${region}:${account}:function:duplicate-target`, RetryPolicy: { MaximumEventAgeInSeconds: 60, MaximumRetryAttempts: 2 } }] }));
  await h.client.send(new PutEventsCommand({ Entries: [{ Source: "duplicate.test", DetailType: "Duplicate", Detail: "{\"value\":1}" }] })); clock.advance(0);
  await waitUntil(() => h.simulator.eventbridge.deliveryDiagnostics().retrying === 1);
  const retryAt = h.simulator.eventbridge.deliveryDiagnostics().deliveries[0].nextAttemptAt;
  for (let tick = 0; tick < 100 && attempts < 2; tick++) { await new Promise(resolve => setTimeout(resolve, 5)); const activeDelivery = h.simulator.eventbridge.deliveryDiagnostics().deliveries[0]; clock.advance(Math.max(0, (activeDelivery?.nextAttemptAt ?? retryAt) - clock.now())); }
  await waitUntil(() => attempts === 2); assert.deepEqual(acceptedPayloads[0], acceptedPayloads[1], "an ambiguous first handoff can be delivered again");
  assert.equal(JSON.stringify(h.simulator.eventbridge.deliveryDiagnostics()).includes("sensitive downstream text"), false, "delivery diagnostics redact raw target errors");

  await h.client.send(new PutRuleCommand({ Name: "age-rule", EventPattern: JSON.stringify({ source: ["age.test"] }) }));
  await h.client.send(new PutTargetsCommand({ Rule: "age-rule", Targets: [{ Id: "lambda", Arn: `arn:aws:lambda:${region}:${account}:function:age-target`, RetryPolicy: { MaximumEventAgeInSeconds: 60, MaximumRetryAttempts: 2 } }] }));
  await h.client.send(new PutEventsCommand({ Entries: [{ Source: "age.test", DetailType: "Age", Detail: "{}" }] }));
  h.client.destroy(); h.clients.splice(h.clients.indexOf(h.client), 1); await h.simulator.stop(); active.splice(active.findIndex(item => item.simulator === h.simulator), 1); clock.advance(60_000);
  const restarted = new StackSim({ port: 0, invokePort: 0, dataDir: h.root, region, clock, authMode: "off"}); let staleHandoffs = 0; await restarted.start(); (restarted.lambda as any).enqueueServiceInvocation = async () => { staleHandoffs++; return "accepted"; }; active.push({ simulator: restarted, root: h.root, clients: [] });
  clock.advance(0); await waitUntil(() => restarted.eventbridge.deliveryDiagnostics().diagnostics.some((item: any) => item.errorCode === "MaximumEventAgeExceeded")); assert.equal(staleHandoffs, 0);
});

test("delivery recovery waits out stale leases and exhausts the configured retry count exactly", async () => {
  const clock = new TestClock(1_700_000_000_000); const h = await harness({ clock });
  await h.client.send(new PutRuleCommand({ Name: "lease-rule", EventPattern: JSON.stringify({ source: ["lease.test"] }) }));
  await h.client.send(new PutTargetsCommand({ Rule: "lease-rule", Targets: [{ Id: "lambda", Arn: `arn:aws:lambda:${region}:${account}:function:lease-target`, RetryPolicy: { MaximumEventAgeInSeconds: 300, MaximumRetryAttempts: 2 } }] }));
  await h.client.send(new PutEventsCommand({ Entries: [{ Source: "lease.test", DetailType: "Lease", Detail: "{}" }] }));
  const journal = join(h.root, "data", "eventbridge", account, region, "deliveries.jsonl");
  const records = (await readFile(journal, "utf8")).trim().split("\n").map(line => JSON.parse(line)); const queued = [...records].reverse().find(record => record.op === "put")!.delivery;
  queued.status = "LEASED"; queued.leaseId = "interrupted-worker"; queued.leaseUntil = clock.now() + 30_000;
  h.client.destroy(); h.clients.splice(h.clients.indexOf(h.client), 1); await h.simulator.stop(); active.splice(active.findIndex(item => item.simulator === h.simulator), 1);
  await appendFile(journal, `${JSON.stringify({ op: "put", delivery: queued })}\n`, "utf8");

  const restarted = new StackSim({ port: 0, invokePort: 0, dataDir: h.root, region, clock, authMode: "off"}); let attempts = 0; await restarted.start();
  (restarted.lambda as any).enqueueServiceInvocation = async () => { attempts++; const error = new Error("retry"); error.name = "TooManyRequestsException"; throw error; };
  active.push({ simulator: restarted, root: h.root, clients: [] });
  clock.advance(29_999); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(attempts, 0, "an unexpired recovered lease is not handed off");
  clock.advance(1);
  for (let tick = 0; tick < 30 && !restarted.eventbridge.deliveryDiagnostics().diagnostics.some((item: any) => item.status === "FAILED"); tick++) {
    await new Promise(resolve => setTimeout(resolve, 3)); const activeDelivery = restarted.eventbridge.deliveryDiagnostics().deliveries[0]; clock.advance(activeDelivery ? Math.max(0, activeDelivery.nextAttemptAt - clock.now()) : 0);
  }
  await waitUntil(() => restarted.eventbridge.deliveryDiagnostics().diagnostics.some((item: any) => item.status === "FAILED"));
  const failed = restarted.eventbridge.deliveryDiagnostics().diagnostics.find((item: any) => item.status === "FAILED"); assert.equal(attempts, 3); assert.equal(failed.attempts, 3);
});

test("shutdown drains an in-flight EventBridge-to-Lambda handoff", async () => {
  const clock = new TestClock(1_700_000_000_000); const h = await harness({ clock }); let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  (h.simulator.lambda as any).enqueueServiceInvocation = async () => { entered(); await gate; return "accepted"; };
  await h.client.send(new PutRuleCommand({ Name: "shutdown-rule", EventPattern: JSON.stringify({ source: ["shutdown.test"] }) }));
  await h.client.send(new PutTargetsCommand({ Rule: "shutdown-rule", Targets: [{ Id: "lambda", Arn: `arn:aws:lambda:${region}:${account}:function:shutdown-target` }] }));
  await h.client.send(new PutEventsCommand({ Entries: [{ Source: "shutdown.test", DetailType: "Shutdown", Detail: "{}" }] })); clock.advance(0); await started;
  let stopped = false; const stopping = h.simulator.stop().then(() => { stopped = true; }); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(stopped, false);
  release(); await stopping; assert.equal(stopped, true); assert.equal(h.simulator.eventbridge.deliveryDiagnostics().diagnostics.some((item: any) => item.status === "SUCCEEDED"), true);
});

test("shutdown drains an accepted Lambda async invocation before its data directory is released", async () => {
  const h = await harness(); const lambda = new LambdaClient({ endpoint: h.endpoint, region, credentials }); h.clients.push(lambda);
  const zip = await readFile(join(process.cwd(), "examples", "lambda", "function.zip")); await lambda.send(new CreateFunctionCommand({ FunctionName: "shutdown-async-handler", Runtime: "nodejs22.x", Role: `arn:aws:iam::${account}:role/test`, Handler: "handler.echoHandler", Code: { ZipFile: zip } }));
  let release!: () => void; let entered!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  (h.simulator.lambda as any).invoke = async () => { entered(); await gate; return { statusCode: 200, payload: Buffer.from("null"), executedVersion: "$LATEST", requestId: "shutdown-async-request", durationMs: 0, billedDurationMs: 1 }; };
  await lambda.send(new InvokeCommand({ FunctionName: "shutdown-async-handler", InvocationType: "Event", Payload: Buffer.from("{}") })); await started;
  let stopped = false; const stopping = h.simulator.stop().then(() => { stopped = true; }); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(stopped, false, "shutdown must wait for the accepted async invocation worker");
  release(); await stopping; assert.equal(stopped, true); assert.equal(Object.keys(h.simulator.store.regionState(region).lambdaAsyncInvocations).length, 0);
});

test("durable target intents survive restart and retry transient Lambda handoff failures", async () => {
  const clock = new TestClock(1_700_000_000_000); const h = await harness({ clock }); const lambdaArn = `arn:aws:lambda:${region}:${account}:function:restart-handler`;
  await h.client.send(new PutRuleCommand({ Name: "restart-rule", EventPattern: JSON.stringify({ source: ["restart.test"] }) }));
  await h.client.send(new PutTargetsCommand({ Rule: "restart-rule", Targets: [{ Id: "lambda", Arn: lambdaArn, RetryPolicy: { MaximumEventAgeInSeconds: 60, MaximumRetryAttempts: 2 } }] }));
  await h.client.send(new PutEventsCommand({ Entries: [{ Source: "restart.test", DetailType: "Restart", Detail: "{\"secret\":\"outside-control-state\"}" }] }));
  assert.equal(h.simulator.eventbridge.deliveryDiagnostics().queued, 1); assert.doesNotMatch(await readFile(join(h.root, "state.json"), "utf8"), /outside-control-state/);
  h.client.destroy(); h.clients.splice(h.clients.indexOf(h.client), 1); await h.simulator.stop(); active.splice(active.findIndex(item => item.simulator === h.simulator), 1);

  const restarted = new StackSim({ port: 0, invokePort: 0, dataDir: h.root, region, clock, authMode: "off"}); let attempts = 0; await restarted.start();
  (restarted.lambda as any).enqueueServiceInvocation = async () => { attempts++; if (attempts === 1) { const error = new Error("try later"); error.name = "TooManyRequestsException"; throw error; } return "accepted"; };
  const cleanup = { simulator: restarted, root: h.root, clients: [] as Array<{ destroy(): void }> }; active.push(cleanup);
  clock.advance(0); await waitUntil(() => restarted.eventbridge.deliveryDiagnostics().retrying === 1);
  for (let tick = 0; tick < 10 && attempts < 2; tick++) { await new Promise(resolve => setTimeout(resolve, 5)); clock.advance(1_000); }
  await waitUntil(() => restarted.eventbridge.deliveryDiagnostics().queued === 0 && restarted.eventbridge.deliveryDiagnostics().leased === 0);
  assert.equal(attempts, 2); assert.equal(restarted.eventbridge.deliveryDiagnostics().diagnostics.some((item: any) => item.status === "SUCCEEDED" && item.attempts === 2), true);
});

test("non-bootstrap EventBridge IAM preserves per-entry PutEvents results and create-time tag authorization", async () => {
  const h = await harness({ authMode: "enforce" }); const iam = new IAMClient({ endpoint: h.endpoint, region, credentials }); const sts = new STSClient({ endpoint: h.endpoint, region, credentials }); h.clients.push(iam, sts);
  await h.client.send(new CreateEventBusCommand({ Name: "iam-allowed" })); await h.client.send(new CreateEventBusCommand({ Name: "iam-denied" }));
  const role = await iam.send(new CreateRoleCommand({ RoleName: "eventbridge-publisher", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${account}:root` }, Action: "sts:AssumeRole" }] }) }));
  const allowedBus = `arn:aws:events:${region}:${account}:event-bus/iam-allowed`; const ruleArn = (name: string) => `arn:aws:events:${region}:${account}:rule/${name}`;
  const policy = await iam.send(new CreatePolicyCommand({ PolicyName: "ScopedEventBridge", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [
    { Effect: "Allow", Action: "events:PutEvents", Resource: allowedBus, Condition: { StringEquals: { "events:source": "allowed.source" } } },
    { Effect: "Allow", Action: "events:PutRule", Resource: [ruleArn("iam-rule"), ruleArn("tagged-rule")] },
  ] }) })); await iam.send(new AttachRolePolicyCommand({ RoleName: "eventbridge-publisher", PolicyArn: policy.Policy!.Arn! }));
  const assumed = await sts.send(new AssumeRoleCommand({ RoleArn: role.Role!.Arn!, RoleSessionName: "publisher" })); const publisher = new EventBridgeClient({ endpoint: h.endpoint, region, credentials: { accessKeyId: assumed.Credentials!.AccessKeyId!, secretAccessKey: assumed.Credentials!.SecretAccessKey!, sessionToken: assumed.Credentials!.SessionToken! } }); h.clients.push(publisher);

  const partial = await publisher.send(new PutEventsCommand({ Entries: [
    { EventBusName: "iam-allowed", Source: "allowed.source", DetailType: "Allowed", Detail: "{}" },
    { EventBusName: "iam-denied", Source: "allowed.source", DetailType: "Denied", Detail: "{}" },
  ] })); assert.equal(partial.FailedEntryCount, 1); assert(partial.Entries?.[0].EventId); assert.equal(partial.Entries?.[1].ErrorCode, "AccessDeniedException");
  const conditionDenied = await publisher.send(new PutEventsCommand({ Entries: [{ EventBusName: "iam-allowed", Source: "wrong.source", DetailType: "Denied", Detail: "{}" }] })); assert.equal(conditionDenied.Entries?.[0].ErrorCode, "AccessDeniedException");

  const pattern = JSON.stringify({ source: ["allowed.source"] }); await publisher.send(new PutRuleCommand({ Name: "iam-rule", EventPattern: pattern })); await publisher.send(new PutRuleCommand({ Name: "iam-rule", EventPattern: pattern, Tags: [{ Key: "ignored", Value: "on-update" }] }));
  await assert.rejects(publisher.send(new PutRuleCommand({ Name: "tagged-rule", EventPattern: pattern, Tags: [{ Key: "team", Value: "dev" }] })), (error: any) => error.name === "AccessDeniedException" && /events:TagResource/.test(error.message));
  const tagPolicy = await iam.send(new CreatePolicyCommand({ PolicyName: "TagEventBridgeRule", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "events:TagResource", Resource: ruleArn("tagged-rule"), Condition: { StringEquals: { "aws:RequestTag/team": "dev" } } }] }) })); await iam.send(new AttachRolePolicyCommand({ RoleName: "eventbridge-publisher", PolicyArn: tagPolicy.Policy!.Arn! }));
  assert.equal((await publisher.send(new PutRuleCommand({ Name: "tagged-rule", EventPattern: pattern, Tags: [{ Key: "team", Value: "dev" }] }))).RuleArn, ruleArn("tagged-rule"));
});

test("EVB-04 IAM targets StartReplay at its required archive and replay reads at the replay ARN", async () => {
  const h = await harness({ authMode: "enforce" }); const iam = new IAMClient({ endpoint: h.endpoint, region, credentials }); const sts = new STSClient({ endpoint: h.endpoint, region, credentials }); h.clients.push(iam, sts);
  const busArn = `arn:aws:events:${region}:${account}:event-bus/default`; const archiveArn = `arn:aws:events:${region}:${account}:archive/iam-archive`; const replayArn = `arn:aws:events:${region}:${account}:replay/iam-replay`;
  await h.client.send(new CreateArchiveCommand({ ArchiveName: "iam-archive", EventSourceArn: busArn }));
  const role = await iam.send(new CreateRoleCommand({ RoleName: "eventbridge-replayer", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${account}:root` }, Action: "sts:AssumeRole" }] }) }));
  const policy = await iam.send(new CreatePolicyCommand({ PolicyName: "ScopedEventBridgeReplay", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "events:StartReplay", Resource: archiveArn }, { Effect: "Allow", Action: "events:DescribeReplay", Resource: replayArn }] }) })); await iam.send(new AttachRolePolicyCommand({ RoleName: "eventbridge-replayer", PolicyArn: policy.Policy!.Arn! }));
  const assumed = await sts.send(new AssumeRoleCommand({ RoleArn: role.Role!.Arn!, RoleSessionName: "replayer" })); const replayer = new EventBridgeClient({ endpoint: h.endpoint, region, credentials: { accessKeyId: assumed.Credentials!.AccessKeyId!, secretAccessKey: assumed.Credentials!.SecretAccessKey!, sessionToken: assumed.Credentials!.SessionToken! } }); h.clients.push(replayer);
  await replayer.send(new StartReplayCommand({ ReplayName: "iam-replay", EventSourceArn: archiveArn, EventStartTime: new Date(Date.now() - 60_000), EventEndTime: new Date(), Destination: { Arn: busArn } })); assert.equal((await replayer.send(new DescribeReplayCommand({ ReplayName: "iam-replay" }))).ReplayArn, replayArn);
  assert(h.simulator.store.ensureAccount().iam.authorizationDecisions.some(decision => decision.action === "events:StartReplay" && decision.resource === archiveArn && decision.decision === "allowed"));
  assert(h.simulator.store.ensureAccount().iam.authorizationDecisions.some(decision => decision.action === "events:DescribeReplay" && decision.resource === replayArn && decision.decision === "allowed"));
});

test("EventBridge enforces caller identity separately from Lambda target resource policies", async () => {
  const h = await harness({ authMode: "enforce" }); const lambda = new LambdaClient({ endpoint: h.endpoint, region, credentials }); h.clients.push(lambda);
  const zip = await readFile(join(process.cwd(), "examples", "lambda", "function.zip")); const fn = await lambda.send(new CreateFunctionCommand({ FunctionName: "event-policy-handler", Runtime: "nodejs22.x", Role: `arn:aws:iam::${account}:role/test`, Handler: "handler.echoHandler", Code: { ZipFile: zip } }));
  const version = await lambda.send(new PublishVersionCommand({ FunctionName: "event-policy-handler" })); await lambda.send(new CreateAliasCommand({ FunctionName: "event-policy-handler", Name: "live", FunctionVersion: version.Version! })); const aliasArn = `${fn.FunctionArn}:live`;
  const rule = await h.client.send(new PutRuleCommand({ Name: "policy-rule", EventPattern: JSON.stringify({ source: ["policy.test"] }) })); await h.client.send(new PutTargetsCommand({ Rule: "policy-rule", Targets: [{ Id: "lambda", Arn: aliasArn }] }));
  await h.client.send(new PutEventsCommand({ Entries: [{ Source: "policy.test", DetailType: "Denied", Detail: "{}" }] })); await waitUntil(() => h.simulator.eventbridge.deliveryDiagnostics().failed === 1);
  await lambda.send(new AddPermissionCommand({ FunctionName: "event-policy-handler", Qualifier: "live", StatementId: "allow-eventbridge", Action: "lambda:InvokeFunction", Principal: "events.amazonaws.com", SourceArn: rule.RuleArn!, SourceAccount: account }));
  await h.client.send(new PutEventsCommand({ Entries: [{ Source: "policy.test", DetailType: "Allowed", Detail: "{}" }] })); await waitUntil(() => h.simulator.eventbridge.deliveryDiagnostics().diagnostics.some((item: any) => item.status === "SUCCEEDED"));
  assert(h.simulator.store.ensureAccount().iam.authorizationDecisions.some(decision => decision.action === "events:PutEvents" && decision.resource.endsWith("event-bus/default") && decision.decision === "allowed"));
});
