import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CloudWatchClient, DeleteAlarmsCommand, DescribeAlarmHistoryCommand, DescribeAlarmsCommand, DescribeAlarmsForMetricCommand, DisableAlarmActionsCommand, EnableAlarmActionsCommand, ListTagsForResourceCommand, PutMetricAlarmCommand, PutMetricDataCommand, SetAlarmStateCommand, TagResourceCommand, UntagResourceCommand,
} from "@aws-sdk/client-cloudwatch";
import { CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { AddPermissionCommand, CreateFunctionCommand, LambdaClient, PutFunctionEventInvokeConfigCommand } from "@aws-sdk/client-lambda";
import { TestClock } from "../src/core/clock.js";
import { AwsError } from "../src/errors.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";
function clients(simulator: StackSim) { const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials }; return { cloudwatch: new CloudWatchClient(options), iam: new IAMClient(options), lambda: new LambdaClient(options) }; }
async function flush(): Promise<void> { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); }
async function waitFor<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for alarm/Lambda work");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function waitForWithClock<T>(clock: TestClock, read: () => T | Promise<T>, accept: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
  return waitFor(async () => {
    clock.advance(0);
    await new Promise(resolve => setImmediate(resolve));
    return read();
  }, accept, timeoutMs);
}

test("CloudWatch metric alarms support M-of-N evaluation, missing data, metric math, lifecycle, history, tags, actions, XML, and restart scheduling", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-alarms-")); const clock = new TestClock(Date.parse("2026-07-15T12:05:00Z")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); let active: ReturnType<typeof clients> | undefined;
  try {
    await simulator.start(); active = clients(simulator); const { cloudwatch, iam, lambda } = active;
    await cloudwatch.send(new PutMetricDataCommand({ Namespace: "Learning/Alarm", MetricData: [
      { MetricName: "Latency", Dimensions: [{ Name: "Route", Value: "/notes" }], Timestamp: new Date("2026-07-15T12:02:05Z"), Value: 11 },
      { MetricName: "Latency", Dimensions: [{ Name: "Route", Value: "/notes" }], Timestamp: new Date("2026-07-15T12:03:05Z"), Value: 9 },
      { MetricName: "Latency", Dimensions: [{ Name: "Route", Value: "/notes" }], Timestamp: new Date("2026-07-15T12:04:05Z"), Value: 11 },
      { MetricName: "Delayed", Timestamp: new Date("2026-07-15T12:01:05Z"), Value: 20 },
      { MetricName: "Delayed", Timestamp: new Date("2026-07-15T12:03:05Z"), Value: 20 },
      { MetricName: "Delayed", Timestamp: new Date("2026-07-15T12:04:05Z"), Value: 20 },
      { MetricName: "Left", Timestamp: new Date("2026-07-15T12:04:05Z"), Value: 7 },
      { MetricName: "Right", Timestamp: new Date("2026-07-15T12:04:05Z"), Value: 6 },
      { MetricName: "Percentile", Timestamp: new Date("2026-07-15T12:04:05Z"), Value: 99 },
    ] }));
    const snsAction = "arn:aws:sns:eu-west-1:000000000000:alarm-topic";
    await cloudwatch.send(new PutMetricAlarmCommand({ AlarmName: "latency-m-of-n", AlarmDescription: "Two of three periods at or above eleven", Namespace: "Learning/Alarm", MetricName: "Latency", Dimensions: [{ Name: "Route", Value: "/notes" }], Period: 60, Statistic: "Average", EvaluationPeriods: 3, DatapointsToAlarm: 2, Threshold: 11, ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "missing", AlarmActions: [snsAction], Tags: [{ Key: "team", Value: "platform" }] }));
    let alarm = (await cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: ["latency-m-of-n"] }))).MetricAlarms![0]; assert.equal(alarm.StateValue, "INSUFFICIENT_DATA"); assert.equal(alarm.DatapointsToAlarm, 2); assert.deepEqual(alarm.Dimensions, [{ Name: "Route", Value: "/notes" }]);
    await simulator.metrics.evaluateAlarmsNow(); alarm = (await cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: ["latency-m-of-n"] }))).MetricAlarms![0]; assert.equal(alarm.StateValue, "ALARM", "the exact-threshold points count as breaching"); assert.equal(JSON.parse(alarm.StateReasonData!).recentDatapoints.length, 3);
    let history = await cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName: "latency-m-of-n" })); assert.ok(history.AlarmHistoryItems?.some(item => item.HistoryItemType === "Action")); assert.match(history.AlarmHistoryItems!.find(item => item.HistoryItemType === "Action")!.HistorySummary!, /queued for durable delivery|will be retried/);

    await cloudwatch.send(new TagResourceCommand({ ResourceARN: alarm.AlarmArn!, Tags: [{ Key: "environment", Value: "test" }] })); assert.deepEqual((await cloudwatch.send(new ListTagsForResourceCommand({ ResourceARN: alarm.AlarmArn! }))).Tags, [{ Key: "environment", Value: "test" }, { Key: "team", Value: "platform" }]); await cloudwatch.send(new UntagResourceCommand({ ResourceARN: alarm.AlarmArn!, TagKeys: ["environment"] }));
    await cloudwatch.send(new PutMetricAlarmCommand({ AlarmName: "latency-m-of-n", Namespace: "Learning/Alarm", MetricName: "Latency", Dimensions: [{ Name: "Route", Value: "/notes" }], Period: 60, Statistic: "Average", EvaluationPeriods: 3, DatapointsToAlarm: 2, Threshold: 10, ComparisonOperator: "GreaterThanThreshold", Tags: [{ Key: "ignored-on-update", Value: "true" }] })); alarm = (await cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: ["latency-m-of-n"] }))).MetricAlarms![0]; assert.equal(alarm.StateValue, "ALARM", "configuration updates retain state"); assert.deepEqual((await cloudwatch.send(new ListTagsForResourceCommand({ ResourceARN: alarm.AlarmArn! }))).Tags, [{ Key: "team", Value: "platform" }]);

    for (const [AlarmName, TreatMissingData, expected] of [["missing-is-alarm", "breaching", "ALARM"], ["missing-is-ok", "notBreaching", "OK"], ["missing-is-insufficient", "missing", "INSUFFICIENT_DATA"], ["missing-is-ignored", "ignore", "INSUFFICIENT_DATA"]] as const) await cloudwatch.send(new PutMetricAlarmCommand({ AlarmName, Namespace: "Learning/Empty", MetricName: "Absent", Period: 60, Statistic: "Sum", EvaluationPeriods: 2, Threshold: 1, ComparisonOperator: "GreaterThanThreshold", TreatMissingData }));
    await cloudwatch.send(new PutMetricAlarmCommand({ AlarmName: "dynamodb-missing-is-ignored", Namespace: "AWS/DynamoDB", MetricName: "ConsumedReadCapacityUnits", Period: 60, Statistic: "Sum", EvaluationPeriods: 1, Threshold: 1, ComparisonOperator: "GreaterThanThreshold", TreatMissingData: "breaching" }));
    await cloudwatch.send(new PutMetricAlarmCommand({ AlarmName: "delayed-m-of-n", Namespace: "Learning/Alarm", MetricName: "Delayed", Period: 60, Statistic: "Average", EvaluationPeriods: 3, DatapointsToAlarm: 2, Threshold: 10, ComparisonOperator: "GreaterThanThreshold", TreatMissingData: "missing" }));
    await cloudwatch.send(new PutMetricAlarmCommand({ AlarmName: "percentile-low-sample", Namespace: "Learning/Alarm", MetricName: "Percentile", Period: 60, ExtendedStatistic: "p90", EvaluationPeriods: 1, Threshold: 50, ComparisonOperator: "GreaterThanThreshold", EvaluateLowSampleCountPercentile: "ignore" }));
    await cloudwatch.send(new PutMetricAlarmCommand({ AlarmName: "math-total", EvaluationPeriods: 1, DatapointsToAlarm: 1, Threshold: 12, ComparisonOperator: "GreaterThanThreshold", Metrics: [
      { Id: "left", ReturnData: false, MetricStat: { Metric: { Namespace: "Learning/Alarm", MetricName: "Left" }, Period: 60, Stat: "Sum" } },
      { Id: "right", ReturnData: false, MetricStat: { Metric: { Namespace: "Learning/Alarm", MetricName: "Right" }, Period: 60, Stat: "Sum" } },
      { Id: "total", Expression: "left + right", Period: 60, ReturnData: true },
    ] }));
    await simulator.metrics.evaluateAlarmsNow(); const evaluated = await cloudwatch.send(new DescribeAlarmsCommand({ AlarmNamePrefix: "missing-" })); assert.deepEqual(Object.fromEntries(evaluated.MetricAlarms!.map(item => [item.AlarmName, item.StateValue])), { "missing-is-alarm": "ALARM", "missing-is-ignored": "INSUFFICIENT_DATA", "missing-is-insufficient": "INSUFFICIENT_DATA", "missing-is-ok": "OK" });
    const special = await cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: ["delayed-m-of-n", "dynamodb-missing-is-ignored", "math-total", "percentile-low-sample"] })); assert.deepEqual(Object.fromEntries(special.MetricAlarms!.map(item => [item.AlarmName, item.StateValue])), { "delayed-m-of-n": "ALARM", "dynamodb-missing-is-ignored": "INSUFFICIENT_DATA", "math-total": "ALARM", "percentile-low-sample": "INSUFFICIENT_DATA" });

    const forMetric = await cloudwatch.send(new DescribeAlarmsForMetricCommand({ Namespace: "Learning/Alarm", MetricName: "Latency", Dimensions: [{ Name: "Route", Value: "/notes" }] })); assert.deepEqual(forMetric.MetricAlarms?.map(item => item.AlarmName), ["latency-m-of-n"]); const firstPage = await cloudwatch.send(new DescribeAlarmsCommand({ AlarmNamePrefix: "missing-", MaxRecords: 1 })); assert.equal(firstPage.MetricAlarms?.length, 1); assert.ok(firstPage.NextToken); assert.equal((await cloudwatch.send(new DescribeAlarmsCommand({ AlarmNamePrefix: "missing-", MaxRecords: 100, NextToken: firstPage.NextToken }))).MetricAlarms?.length, 3);

    await cloudwatch.send(new DisableAlarmActionsCommand({ AlarmNames: ["latency-m-of-n"] })); const before = (await cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName: "latency-m-of-n", HistoryItemType: "Action" }))).AlarmHistoryItems!.length; await cloudwatch.send(new SetAlarmStateCommand({ AlarmName: "latency-m-of-n", StateValue: "OK", StateReason: "local test", StateReasonData: JSON.stringify({ test: true }) })); assert.equal((await cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName: "latency-m-of-n", HistoryItemType: "Action" }))).AlarmHistoryItems!.length, before); await cloudwatch.send(new EnableAlarmActionsCommand({ AlarmNames: ["latency-m-of-n"] }));

    const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }); await iam.send(new CreateRoleCommand({ RoleName: "alarm-role", AssumeRolePolicyDocument: trust })); const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip")); const fn = await lambda.send(new CreateFunctionCommand({ FunctionName: "alarm-action", Runtime: "nodejs22.x", Role: "arn:aws:iam::000000000000:role/alarm-role", Handler: "handler.alarmActionHandler", Code: { ZipFile: zip } })); await flush();
    await cloudwatch.send(new PutMetricAlarmCommand({ AlarmName: "lambda-action", Namespace: "Learning/Empty", MetricName: "Absent", Period: 60, Statistic: "Sum", EvaluationPeriods: 1, Threshold: 0, ComparisonOperator: "GreaterThanThreshold", TreatMissingData: "breaching", AlarmActions: [fn.FunctionArn!] })); await simulator.metrics.evaluateAlarmsNow(); await waitFor(() => cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName: "lambda-action", HistoryItemType: "Action" })), result => (result.AlarmHistoryItems ?? []).some(item => /Successfully executed/.test(item.HistorySummary ?? "")));

    const raw = await fetch(`http://127.0.0.1:${simulator.port}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-stacksim-region": "eu-west-1" }, body: new URLSearchParams({ Action: "PutMetricAlarm", Version: "2010-08-01", AlarmName: "query-protocol", Namespace: "Learning/XML", MetricName: "Requests", Period: "60", Statistic: "Sum", EvaluationPeriods: "1", Threshold: "2", ComparisonOperator: "GreaterThanThreshold" }) }); assert.equal(raw.status, 200); assert.match(await raw.text(), /<PutMetricAlarmResponse/);

    await cloudwatch.send(new PutMetricDataCommand({ Namespace: "Learning/Restart", MetricData: [{ MetricName: "HighResolution", StorageResolution: 1, Timestamp: new Date("2026-07-15T12:05:05Z"), Value: 5 }] })); await cloudwatch.send(new PutMetricAlarmCommand({ AlarmName: "restart-scheduled", Namespace: "Learning/Restart", MetricName: "HighResolution", Period: 10, Statistic: "Sum", EvaluationPeriods: 1, Threshold: 1, ComparisonOperator: "GreaterThanThreshold" }));
    Object.values(active).forEach(client => client.destroy()); active = undefined; await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); await simulator.start(); active = clients(simulator); assert.equal((await active.cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: ["restart-scheduled"] }))).MetricAlarms?.[0].StateValue, "INSUFFICIENT_DATA"); clock.advance(10_000); for (let attempt = 0; attempt < 50; attempt++) { if ((await active.cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: ["restart-scheduled"] }))).MetricAlarms?.[0].StateValue === "ALARM") break; await new Promise(resolve => setTimeout(resolve, 10)); } assert.equal((await active.cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: ["restart-scheduled"] }))).MetricAlarms?.[0].StateValue, "ALARM"); assert.ok((await active.cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName: "latency-m-of-n" }))).AlarmHistoryItems!.length > 0);
    await active.cloudwatch.send(new DeleteAlarmsCommand({ AlarmNames: ["query-protocol"] })); assert.equal((await active.cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: ["query-protocol"] }))).MetricAlarms?.length, 0); assert.equal((await active.cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName: "query-protocol" }))).AlarmHistoryItems?.[0].HistoryItemType, "ConfigurationUpdate", "history remains after deletion");
  } finally { if (active) Object.values(active).forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test("CloudWatch alarm history uses the configured retention window", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-alarm-retention-")); const clock = new TestClock(Date.parse("2026-07-15T10:00:00Z")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, alarmHistoryRetentionMs: 1_000, authMode: "off"}); let cloudwatch: CloudWatchClient | undefined;
  try { await simulator.start(); cloudwatch = new CloudWatchClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials }); await cloudwatch.send(new PutMetricAlarmCommand({ AlarmName: "short-history", Namespace: "Learning/Retention", MetricName: "Value", Period: 60, Statistic: "Sum", EvaluationPeriods: 1, Threshold: 0, ComparisonOperator: "GreaterThanThreshold" })); assert.equal((await cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName: "short-history" }))).AlarmHistoryItems?.length, 1); clock.advance(2_000); assert.equal((await cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName: "short-history" }))).AlarmHistoryItems?.length, 0); }
  finally { cloudwatch?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test("CloudWatch Lambda alarm actions require and honor the alarm service resource permission in enforcement mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-alarm-permission-")); const clock = new TestClock(Date.now()); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "enforce", cdkBootstrap: true }); let active: ReturnType<typeof clients> | undefined;
  try {
    await simulator.start(); active = clients(simulator); const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }); await active.iam.send(new CreateRoleCommand({ RoleName: "alarm-enforced-role", AssumeRolePolicyDocument: trust })); const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip")); const fn = await active.lambda.send(new CreateFunctionCommand({ FunctionName: "alarm-enforced-action", Runtime: "nodejs22.x", Role: "arn:aws:iam::000000000000:role/alarm-enforced-role", Handler: "handler.alarmActionHandler", Code: { ZipFile: zip } })); await flush();
    const AlarmName = "permission-alarm"; const AlarmArn = `arn:aws:cloudwatch:eu-west-1:000000000000:alarm:${AlarmName}`; await active.cloudwatch.send(new PutMetricAlarmCommand({ AlarmName, Namespace: "Learning/Permission", MetricName: "Absent", Period: 60, Statistic: "Sum", EvaluationPeriods: 1, Threshold: 0, ComparisonOperator: "GreaterThanThreshold", TreatMissingData: "breaching", AlarmActions: [fn.FunctionArn!] })); await simulator.metrics.evaluateAlarmsNow(Math.floor(clock.now() / 60_000) * 60_000);
    for (let attempt = 0; attempt < 30; attempt++) { const items = (await active.cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName, HistoryItemType: "Action" }))).AlarmHistoryItems ?? []; if (items.length) break; await new Promise(resolve => setTimeout(resolve, 10)); } let actions = (await active.cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName, HistoryItemType: "Action" }))).AlarmHistoryItems ?? []; assert.match(actions[0].HistorySummary!, /Failed to execute/);
    await active.lambda.send(new AddPermissionCommand({ FunctionName: "alarm-enforced-action", StatementId: "cloudwatch-alarm", Action: "lambda:InvokeFunction", Principal: "lambda.alarms.cloudwatch.amazonaws.com", SourceArn: AlarmArn, SourceAccount: "000000000000" })); await active.cloudwatch.send(new SetAlarmStateCommand({ AlarmName, StateValue: "OK", StateReason: "reset before permitted transition" })); await active.cloudwatch.send(new SetAlarmStateCommand({ AlarmName, StateValue: "ALARM", StateReason: "permitted transition" }));
    for (let attempt = 0; attempt < 50; attempt++) { actions = (await active.cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName, HistoryItemType: "Action" }))).AlarmHistoryItems ?? []; if (actions.some(item => /Successfully executed/.test(item.HistorySummary ?? ""))) break; await new Promise(resolve => setTimeout(resolve, 20)); } assert.ok(actions.some(item => /Successfully executed/.test(item.HistorySummary ?? ""))); assert.ok(simulator.store.ensureAccount().iam.authorizationDecisions.some(item => item.action === "cloudwatch:PutMetricAlarm" && item.resource === AlarmArn));
  } finally { if (active) Object.values(active).forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test("DUG-06 durably enqueues alarm Lambda actions, survives restart, deduplicates, and separates handoff from execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-dug06-alarms-"));
  const clock = new TestClock(Date.parse("2026-08-03T12:00:00.000Z"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
  let active: ReturnType<typeof clients> | undefined;
  const role = "arn:aws:iam::000000000000:role/alarm-role";
  const AlarmName = "dug06-restart";
  const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip"));

  try {
    await simulator.start();
    active = clients(simulator);
    await active.iam.send(new CreateRoleCommand({ RoleName: "alarm-role", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }));
    const fn = await active.lambda.send(new CreateFunctionCommand({ FunctionName: "dug06-alarm-action", Runtime: "nodejs22.x", Role: role, Handler: "handler.alarmActionHandler", Code: { ZipFile: zip } }));
    await flush();
    await active.cloudwatch.send(new PutMetricAlarmCommand({ AlarmName, Namespace: "Learning/Empty", MetricName: "Absent", Period: 60, Statistic: "Sum", EvaluationPeriods: 1, Threshold: 0, ComparisonOperator: "GreaterThanThreshold", TreatMissingData: "breaching", AlarmActions: [fn.FunctionArn!] }));

    const originalEnqueue = simulator.lambda.enqueueServiceInvocation.bind(simulator.lambda);
    let enqueueFailures = 0;
    simulator.lambda.enqueueServiceInvocation = async (...args) => {
      if (++enqueueFailures === 1) throw new AwsError("InternalFailure", "injected retryable handoff failure", 500);
      return originalEnqueue(...args);
    };
    await active.cloudwatch.send(new SetAlarmStateCommand({ AlarmName, StateValue: "OK", StateReason: "reset" }));
    await active.cloudwatch.send(new SetAlarmStateCommand({ AlarmName, StateValue: "ALARM", StateReason: "durable handoff" }));
    const outboxBeforeRestart = await waitFor(() => simulator.store.regionState(region).cloudwatch.lambdaActionOutbox ?? [], items => items.length === 1);
    const actionId = outboxBeforeRestart[0]!.id;
    assert.equal(outboxBeforeRestart[0]?.attempts, 1);

    active.cloudwatch.destroy(); active.iam.destroy(); active.lambda.destroy(); active = undefined;
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
    await simulator.start();
    active = clients(simulator);
    assert.deepEqual((simulator.store.regionState(region).cloudwatch.lambdaActionOutbox ?? []).map(item => item.id), [actionId]);

    clock.advance(1_000);
    await waitFor(() => Object.keys(simulator.store.regionState(region).lambdaAsyncInvocations), keys => keys.length === 1 && keys[0] === actionId);
    assert.equal(Object.keys(simulator.store.regionState(region).lambdaAsyncInvocations).length, 1);
    await waitFor(() => simulator.store.regionState(region).cloudwatch.lambdaActionOutbox ?? [], items => items.length === 0);
    const actions = await waitFor(() => active!.cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName, HistoryItemType: "Action" })), result => (result.AlarmHistoryItems ?? []).some(item => /Successfully executed/.test(item.HistorySummary ?? "")));
    assert.ok(actions.AlarmHistoryItems!.some(item => /Successfully executed/.test(item.HistorySummary ?? "")));
    assert.ok(actions.AlarmHistoryItems!.some(item => /queued for durable delivery/.test(item.HistorySummary ?? "")));

    const failFn = await active.lambda.send(new CreateFunctionCommand({ FunctionName: "dug06-throwing-action", Runtime: "nodejs22.x", Role: role, Handler: "handler.throwingHandler", Code: { ZipFile: zip } }));
    await active.lambda.send(new PutFunctionEventInvokeConfigCommand({ FunctionName: "dug06-throwing-action", MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 300 }));
    const FailAlarm = "dug06-throwing";
    await active.cloudwatch.send(new PutMetricAlarmCommand({ AlarmName: FailAlarm, Namespace: "Learning/Empty", MetricName: "Absent2", Period: 60, Statistic: "Sum", EvaluationPeriods: 1, Threshold: 0, ComparisonOperator: "GreaterThanThreshold", TreatMissingData: "breaching", AlarmActions: [failFn.FunctionArn!] }));
    await active.cloudwatch.send(new SetAlarmStateCommand({ AlarmName: FailAlarm, StateValue: "ALARM", StateReason: "function failure path" }));
    await waitFor(() => active!.cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName: FailAlarm, HistoryItemType: "Action" })), result => (result.AlarmHistoryItems ?? []).some(item => /Successfully executed/.test(item.HistorySummary ?? "")));
    await waitForWithClock(clock, () => Object.values(simulator.store.regionState(region).lambdaAsyncInvocations).find(item => item.functionName === "dug06-throwing-action"), Boolean);
    clock.advance(60_000);
    await waitForWithClock(clock, () => Object.values(simulator.store.regionState(region).lambdaAsyncInvocations).find(item => item.functionName === "dug06-throwing-action")?.attempts ?? 0, attempts => attempts >= 1);
    assert.equal((await active.cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName: FailAlarm, HistoryItemType: "Action" }))).AlarmHistoryItems!.filter(item => /Failed to execute/.test(item.HistorySummary ?? "")).length, 0, "alarm handoff success must not depend on function execution outcome");
  } finally {
    if (active) Object.values(active).forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("DUG-06 rejects missing Lambda targets terminally and expires aged outbox work", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-dug06-terminal-"));
  const clock = new TestClock(Date.parse("2026-08-03T13:00:00.000Z"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
  let active: ReturnType<typeof clients> | undefined;
  const AlarmName = "dug06-missing";
  const missingArn = `arn:aws:lambda:${region}:000000000000:function:does-not-exist`;
  try {
    await simulator.start();
    active = clients(simulator);
    await active.cloudwatch.send(new PutMetricAlarmCommand({ AlarmName, Namespace: "Learning/Empty", MetricName: "Absent", Period: 60, Statistic: "Sum", EvaluationPeriods: 1, Threshold: 0, ComparisonOperator: "GreaterThanThreshold", TreatMissingData: "breaching", AlarmActions: [missingArn] }));
    await active.cloudwatch.send(new SetAlarmStateCommand({ AlarmName, StateValue: "ALARM", StateReason: "missing target" }));
    await waitFor(() => active!.cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName, HistoryItemType: "Action" })), result => (result.AlarmHistoryItems ?? []).some(item => /Failed to execute/.test(item.HistorySummary ?? "")));
    assert.equal(Object.keys(simulator.store.regionState(region).lambdaAsyncInvocations).length, 0);
    assert.deepEqual(simulator.store.regionState(region).cloudwatch.lambdaActionOutbox, []);

    const agedAlarm = "dug06-aged";
    await active.cloudwatch.send(new PutMetricAlarmCommand({ AlarmName: agedAlarm, Namespace: "Learning/Empty", MetricName: "Absent2", Period: 60, Statistic: "Sum", EvaluationPeriods: 1, Threshold: 0, ComparisonOperator: "GreaterThanThreshold", TreatMissingData: "breaching", AlarmActions: [missingArn] }));
    simulator.store.regionState(region).cloudwatch.lambdaActionOutbox!.push({
      id: "aged-action-id",
      functionArn: missingArn,
      payloadBase64: Buffer.from(JSON.stringify({ stale: true })).toString("base64"),
      alarmName: agedAlarm,
      state: "ALARM",
      transitionAt: clock.now(),
      createdAt: clock.now() - 86_400_001,
      attempts: 0,
      nextAttemptAt: clock.now(),
      deliveryLineage: [`arn:aws:cloudwatch:${region}:000000000000:alarm:${agedAlarm}`],
    });
    await simulator.store.save();
    await simulator.metrics.alarms.start();
    await waitFor(() => active!.cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName: agedAlarm, HistoryItemType: "Action" })), result => (result.AlarmHistoryItems ?? []).some(item => /maximum outbox age/.test(item.HistoryData ?? "")));
    assert.deepEqual(simulator.store.regionState(region).cloudwatch.lambdaActionOutbox, []);
  } finally {
    if (active) Object.values(active).forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("DUG-06 schema migration initializes the Lambda action outbox", async () => {
  const { migrateV74ToV75 } = await import("../src/migrations/v74-to-v75.js");
  const state = {
    schemaVersion: 74,
    accounts: {
      "000000000000": {
        regions: {
          [region]: {
            cloudwatch: { alarms: {}, compositeAlarms: {}, logAlarms: {}, alarmMuteRules: {}, anomalyDetectors: {}, metricStreams: {}, insightRules: {}, alarmHistory: [], eventBridgeOutbox: [], snsActionOutbox: [] },
          },
        },
      },
    },
  } as any;
  const migrated = migrateV74ToV75(state);
  assert.equal(migrated.schemaVersion, 75);
  assert.deepEqual(migrated.accounts["000000000000"].regions[region].cloudwatch.lambdaActionOutbox, []);
});
