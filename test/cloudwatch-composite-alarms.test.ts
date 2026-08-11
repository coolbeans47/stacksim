import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CloudWatchClient,
  DeleteAlarmsCommand,
  DescribeAlarmHistoryCommand,
  DescribeAlarmsCommand,
  ListTagsForResourceCommand,
  PutCompositeAlarmCommand,
  PutMetricAlarmCommand,
  SetAlarmStateCommand,
  TagResourceCommand,
} from "@aws-sdk/client-cloudwatch";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
function client(simulator: StackSim): CloudWatchClient { return new CloudWatchClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials }); }
async function metricAlarm(cloudwatch: CloudWatchClient, AlarmName: string): Promise<void> { await cloudwatch.send(new PutMetricAlarmCommand({ AlarmName, Namespace: "Learning/Composite", MetricName: AlarmName, Period: 60, Statistic: "Sum", EvaluationPeriods: 1, Threshold: 0, ComparisonOperator: "GreaterThanThreshold" })); }
async function state(cloudwatch: CloudWatchClient, AlarmName: string, StateValue: "OK" | "ALARM" | "INSUFFICIENT_DATA"): Promise<void> { await cloudwatch.send(new SetAlarmStateCommand({ AlarmName, StateValue, StateReason: `Set ${AlarmName} to ${StateValue}` })); }

test("CW-08A composite alarms evaluate rules, relationships, cycles, suppression, history, tags, Query XML, deletion, and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-composite-alarms-")); const clock = new TestClock(Date.parse("2026-07-17T08:00:00Z")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); let cloudwatch: CloudWatchClient | undefined;
  try {
    await simulator.start(); cloudwatch = client(simulator);
    for (const alarm of ["api-unhealthy", "database-unhealthy", "deployment", "maintenance"]) await metricAlarm(cloudwatch, alarm);
    await state(cloudwatch, "api-unhealthy", "ALARM"); await state(cloudwatch, "database-unhealthy", "OK"); await state(cloudwatch, "deployment", "OK"); await state(cloudwatch, "maintenance", "OK");

    const dependencyAction = "arn:aws:sns:eu-west-1:000000000000:operations";
    await cloudwatch.send(new PutCompositeAlarmCommand({ AlarmName: "service-unhealthy", AlarmDescription: "API or database unhealthy outside a deployment", AlarmRule: '(ALARM("api-unhealthy") OR ALARM(database-unhealthy)) AND NOT ALARM(deployment)', AlarmActions: [dependencyAction], Tags: [{ Key: "team", Value: "platform" }] }));
    let described = await cloudwatch.send(new DescribeAlarmsCommand({ AlarmTypes: ["CompositeAlarm"], AlarmNames: ["service-unhealthy"] })); let composite = described.CompositeAlarms![0]; assert.equal(composite.StateValue, "ALARM"); assert.equal(composite.AlarmRule, '(ALARM("api-unhealthy") OR ALARM(database-unhealthy)) AND NOT ALARM(deployment)'); assert.equal(described.MetricAlarms?.length, 0);
    assert.equal((await cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: ["service-unhealthy"] }))).CompositeAlarms?.length, 0, "DescribeAlarms defaults to metric alarms");
    const children = await cloudwatch.send(new DescribeAlarmsCommand({ ChildrenOfAlarmName: "service-unhealthy" })); assert.deepEqual(children.MetricAlarms?.map(item => item.AlarmName), ["api-unhealthy", "database-unhealthy", "deployment"]); assert.deepEqual((await cloudwatch.send(new DescribeAlarmsCommand({ ParentsOfAlarmName: "api-unhealthy" }))).CompositeAlarms?.map(item => item.AlarmName), ["service-unhealthy"]);
    await cloudwatch.send(new TagResourceCommand({ ResourceARN: composite.AlarmArn!, Tags: [{ Key: "environment", Value: "test" }] })); assert.deepEqual((await cloudwatch.send(new ListTagsForResourceCommand({ ResourceARN: composite.AlarmArn! }))).Tags, [{ Key: "environment", Value: "test" }, { Key: "team", Value: "platform" }]);
    const history = await cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName: "service-unhealthy", AlarmTypes: ["CompositeAlarm"] })); assert.ok(history.AlarmHistoryItems?.some(item => item.AlarmType === "CompositeAlarm" && item.HistoryItemType === "StateUpdate")); assert.ok(history.AlarmHistoryItems?.some(item => item.HistoryItemType === "Action" && /queued for durable delivery|will be retried/.test(item.HistorySummary ?? "")));

    await state(cloudwatch, "deployment", "ALARM"); composite = (await cloudwatch.send(new DescribeAlarmsCommand({ AlarmTypes: ["CompositeAlarm"], AlarmNames: ["service-unhealthy"] }))).CompositeAlarms![0]; assert.equal(composite.StateValue, "OK");
    await state(cloudwatch, "deployment", "OK"); assert.equal((await cloudwatch.send(new DescribeAlarmsCommand({ AlarmTypes: ["CompositeAlarm"], AlarmNames: ["service-unhealthy"] }))).CompositeAlarms![0].StateValue, "ALARM");
    await cloudwatch.send(new PutCompositeAlarmCommand({ AlarmName: "page-operations", AlarmRule: 'ALARM(service-unhealthy) AND OK("maintenance")' })); const parents = await cloudwatch.send(new DescribeAlarmsCommand({ ParentsOfAlarmName: "service-unhealthy" })); assert.deepEqual(parents.CompositeAlarms?.map(item => item.AlarmName), ["page-operations"]); assert.equal((await cloudwatch.send(new DescribeAlarmsCommand({ AlarmTypes: ["CompositeAlarm"], AlarmNames: ["page-operations"] }))).CompositeAlarms![0].StateValue, "ALARM");

    await cloudwatch.send(new PutCompositeAlarmCommand({ AlarmName: "cycle-a", AlarmRule: "ALARM(cycle-b)" })); await cloudwatch.send(new PutCompositeAlarmCommand({ AlarmName: "cycle-b", AlarmRule: "ALARM(cycle-a)" })); described = await cloudwatch.send(new DescribeAlarmsCommand({ AlarmTypes: ["CompositeAlarm"], AlarmNames: ["cycle-a", "cycle-b"] })); assert.ok(described.CompositeAlarms?.every(item => /cycle was detected/.test(item.StateReason ?? ""))); await assert.rejects(cloudwatch.send(new DeleteAlarmsCommand({ AlarmNames: ["cycle-a"] })), /still referenced/); await cloudwatch.send(new PutCompositeAlarmCommand({ AlarmName: "cycle-b", AlarmRule: "FALSE" })); await cloudwatch.send(new DeleteAlarmsCommand({ AlarmNames: ["cycle-a"] })); await cloudwatch.send(new DeleteAlarmsCommand({ AlarmNames: ["cycle-b"] }));

    await cloudwatch.send(new PutCompositeAlarmCommand({ AlarmName: "waited-action", AlarmRule: "TRUE", AlarmActions: [dependencyAction], ActionsSuppressor: "maintenance", ActionsSuppressorWaitPeriod: 5, ActionsSuppressorExtensionPeriod: 3 })); composite = (await cloudwatch.send(new DescribeAlarmsCommand({ AlarmTypes: ["CompositeAlarm"], AlarmNames: ["waited-action"] }))).CompositeAlarms![0]; assert.equal(composite.ActionsSuppressedBy, "WaitPeriod"); clock.advance(6_000); await simulator.metrics.evaluateAlarmsNow(clock.now()); composite = (await cloudwatch.send(new DescribeAlarmsCommand({ AlarmTypes: ["CompositeAlarm"], AlarmNames: ["waited-action"] }))).CompositeAlarms![0]; assert.equal(composite.ActionsSuppressedBy, undefined); assert.ok((await cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName: "waited-action", HistoryItemType: "Action" }))).AlarmHistoryItems?.some(item => /queued for durable delivery|will be retried/.test(item.HistorySummary ?? "")));
    await state(cloudwatch, "maintenance", "ALARM"); await cloudwatch.send(new PutCompositeAlarmCommand({ AlarmName: "suppressed-action", AlarmRule: "TRUE", AlarmActions: [dependencyAction], ActionsSuppressor: "maintenance", ActionsSuppressorWaitPeriod: 5, ActionsSuppressorExtensionPeriod: 3 })); composite = (await cloudwatch.send(new DescribeAlarmsCommand({ AlarmTypes: ["CompositeAlarm"], AlarmNames: ["suppressed-action"] }))).CompositeAlarms![0]; assert.equal(composite.ActionsSuppressedBy, "Alarm"); await state(cloudwatch, "maintenance", "OK"); composite = (await cloudwatch.send(new DescribeAlarmsCommand({ AlarmTypes: ["CompositeAlarm"], AlarmNames: ["suppressed-action"] }))).CompositeAlarms![0]; assert.equal(composite.ActionsSuppressedBy, "ExtensionPeriod"); clock.advance(4_000); await simulator.metrics.evaluateAlarmsNow(clock.now()); assert.equal((await cloudwatch.send(new DescribeAlarmsCommand({ AlarmTypes: ["CompositeAlarm"], AlarmNames: ["suppressed-action"] }))).CompositeAlarms![0].ActionsSuppressedBy, undefined); assert.ok((await cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName: "suppressed-action", HistoryItemType: "Action" }))).AlarmHistoryItems?.some(item => /queued for durable delivery|will be retried/.test(item.HistorySummary ?? "")), "the current-state action runs when the extension period expires");

    await cloudwatch.send(new PutCompositeAlarmCommand({ AlarmName: "delete-one", AlarmRule: "TRUE" })); await cloudwatch.send(new PutCompositeAlarmCommand({ AlarmName: "delete-two", AlarmRule: "FALSE" })); await assert.rejects(cloudwatch.send(new DeleteAlarmsCommand({ AlarmNames: ["delete-one", "delete-two"] })), /no more than one composite/); await cloudwatch.send(new DeleteAlarmsCommand({ AlarmNames: ["delete-one"] })); await cloudwatch.send(new DeleteAlarmsCommand({ AlarmNames: ["delete-two"] }));
    await assert.rejects(cloudwatch.send(new PutCompositeAlarmCommand({ AlarmName: "invalid-rule", AlarmRule: "ALARM(a) AND" })), /AlarmRule is invalid/);

    const raw = await fetch(`http://127.0.0.1:${simulator.port}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-stacksim-region": "eu-west-1" }, body: new URLSearchParams({ Action: "PutCompositeAlarm", Version: "2010-08-01", AlarmName: "query-composite", AlarmRule: "TRUE" }) }); assert.equal(raw.status, 200); assert.match(await raw.text(), /<PutCompositeAlarmResponse/);
    cloudwatch.destroy(); cloudwatch = undefined; await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); await simulator.start(); cloudwatch = client(simulator); assert.equal((await cloudwatch.send(new DescribeAlarmsCommand({ AlarmTypes: ["CompositeAlarm"], AlarmNames: ["service-unhealthy", "query-composite"] }))).CompositeAlarms?.length, 2); assert.ok((await cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName: "service-unhealthy", AlarmTypes: ["CompositeAlarm"] }))).AlarmHistoryItems?.length);
  } finally { cloudwatch?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});
