import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CloudWatchClient,
  DeleteAnomalyDetectorCommand,
  DescribeAlarmsCommand,
  DescribeAnomalyDetectorsCommand,
  GetMetricDataCommand,
  PutAnomalyDetectorCommand,
  PutMetricAlarmCommand,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import { TestClock } from "../src/core/clock.js";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
function client(simulator: StackSim): CloudWatchClient { return new CloudWatchClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials }); }

test("CloudWatch anomaly detectors support current and legacy identities, deterministic bands, anomaly alarms, XML, pagination, and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-anomaly-")); const clock = new TestClock(Date.parse("2026-07-17T12:20:00Z")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); let cloudwatch: CloudWatchClient | undefined;
  const single = { Namespace: "Learning/Anomaly", MetricName: "Latency", Dimensions: [{ Name: "Route", Value: "/notes" }], Stat: "Average" };
  const metricQuery = { Id: "m1", ReturnData: false, MetricStat: { Metric: { Namespace: single.Namespace, MetricName: single.MetricName, Dimensions: single.Dimensions }, Period: 60, Stat: single.Stat } };
  try {
    await simulator.start(); cloudwatch = client(simulator);
    await cloudwatch.send(new PutMetricDataCommand({ Namespace: single.Namespace, MetricData: Array.from({ length: 12 }, (_, index) => ({ MetricName: single.MetricName, Dimensions: single.Dimensions, Timestamp: new Date(Date.parse("2026-07-17T12:00:05Z") + index * 60_000), Value: index === 5 ? 200 : 10 })) }));
    const created = await cloudwatch.send(new PutAnomalyDetectorCommand({ SingleMetricAnomalyDetector: single, Configuration: { ExcludedTimeRanges: [{ StartTime: new Date("2026-07-17T12:05:00Z"), EndTime: new Date("2026-07-17T12:06:00Z") }], MetricTimezone: "Europe/London" }, MetricCharacteristics: { PeriodicSpikes: true } })); assert.match(created.AnomalyDetectorId ?? "", /^ad-[a-f0-9]{32}$/);
    let described = await cloudwatch.send(new DescribeAnomalyDetectorsCommand({})); assert.equal(described.AnomalyDetectors?.length, 1); assert.equal(described.AnomalyDetectors?.[0].StateValue, "PENDING_TRAINING"); assert.equal(described.AnomalyDetectors?.[0].Configuration?.MetricTimezone, "Europe/London"); assert.deepEqual(described.AnomalyDetectors?.[0].SingleMetricAnomalyDetector?.Dimensions, single.Dimensions); assert.equal(described.AnomalyDetectors?.[0].Namespace, single.Namespace, "deprecated response fields remain compatible");

    const mathQueries = [metricQuery, { Id: "doubled", Expression: "m1 * 2", ReturnData: true }]; const math = await cloudwatch.send(new PutAnomalyDetectorCommand({ MetricMathAnomalyDetector: { MetricDataQueries: mathQueries }, Configuration: { MetricTimezone: "UTC" } })); assert.notEqual(math.AnomalyDetectorId, created.AnomalyDetectorId);
    described = await cloudwatch.send(new DescribeAnomalyDetectorsCommand({ AnomalyDetectorTypes: ["SINGLE_METRIC", "METRIC_MATH"], MaxResults: 1 })); assert.equal(described.AnomalyDetectors?.length, 1); assert.ok(described.NextToken); const secondPage = await cloudwatch.send(new DescribeAnomalyDetectorsCommand({ AnomalyDetectorTypes: ["SINGLE_METRIC", "METRIC_MATH"], MaxResults: 1, NextToken: described.NextToken })); assert.equal(secondPage.AnomalyDetectors?.length, 1);

    const band = await cloudwatch.send(new GetMetricDataCommand({ StartTime: new Date("2026-07-17T12:00:00Z"), EndTime: new Date("2026-07-17T12:12:00Z"), ScanBy: "TimestampAscending", MetricDataQueries: [metricQuery, { Id: "band", Expression: "ANOMALY_DETECTION_BAND(m1, 2)" }] })); assert.deepEqual(band.MetricDataResults?.map(result => result.Id), ["band", "band"]); assert.match(band.MetricDataResults?.[0].Label ?? "", /\(lower\)$/); assert.match(band.MetricDataResults?.[1].Label ?? "", /\(upper\)$/); assert.equal(band.MetricDataResults?.[0].Values?.length, 12); assert.ok(Math.max(...(band.MetricDataResults?.[1].Values ?? [])) < 20, "the excluded deployment spike does not widen the deterministic training band");

    clock.advance(15 * 60_000); described = await cloudwatch.send(new DescribeAnomalyDetectorsCommand({ AnomalyDetectorIds: [created.AnomalyDetectorId!] })); assert.equal(described.AnomalyDetectors?.[0].StateValue, "TRAINED");
    await cloudwatch.send(new PutMetricDataCommand({ Namespace: single.Namespace, MetricData: [{ MetricName: single.MetricName, Dimensions: single.Dimensions, Timestamp: new Date(clock.now() - 55_000), Value: 100 }] })); await cloudwatch.send(new PutMetricAlarmCommand({ AlarmName: "latency-anomaly", EvaluationPeriods: 1, DatapointsToAlarm: 1, ComparisonOperator: "LessThanLowerOrGreaterThanUpperThreshold", ThresholdMetricId: "band", Metrics: [{ ...metricQuery, ReturnData: true }, { Id: "band", Expression: "ANOMALY_DETECTION_BAND(m1, 2)" }] })); await simulator.metrics.evaluateAlarmsNow(clock.now()); const alarm = (await cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: ["latency-anomaly"] }))).MetricAlarms?.[0]; assert.equal(alarm?.StateValue, "ALARM"); assert.equal(alarm?.ThresholdMetricId, "band"); assert.equal(alarm?.Threshold, undefined); const reason = JSON.parse(alarm?.StateReasonData ?? "{}"); assert.equal(reason.evaluatedDatapoints[0].value, 100); assert.ok(reason.evaluatedDatapoints[0].upper < 20);

    await assert.rejects(cloudwatch.send(new PutAnomalyDetectorCommand({ SingleMetricAnomalyDetector: single, Namespace: single.Namespace })), (error: any) => error.name === "InvalidParameterCombinationException"); await assert.rejects(cloudwatch.send(new PutAnomalyDetectorCommand({ SingleMetricAnomalyDetector: single, Configuration: { MetricTimezone: "Not/A_Timezone" } })), (error: any) => error.name === "InvalidParameterValueException");
    const raw = await fetch(`http://127.0.0.1:${simulator.port}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-stacksim-region": "eu-west-1" }, body: new URLSearchParams({ Action: "PutAnomalyDetector", Version: "2010-08-01", Namespace: "Learning/XML", MetricName: "Requests", Stat: "Sum", "Configuration.MetricTimezone": "UTC" }) }); const xml = await raw.text(); assert.equal(raw.status, 200); assert.match(xml, /<PutAnomalyDetectorResponse/); assert.match(xml, /<AnomalyDetectorId>ad-/);

    await cloudwatch.send(new DeleteAnomalyDetectorCommand({ AnomalyDetectorId: created.AnomalyDetectorId })); assert.equal((await cloudwatch.send(new DescribeAnomalyDetectorsCommand({ AnomalyDetectorTypes: ["SINGLE_METRIC", "METRIC_MATH"] }))).AnomalyDetectors?.length, 2, "the metric-math and XML detectors remain");
    cloudwatch.destroy(); cloudwatch = undefined; await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); await simulator.start(); cloudwatch = client(simulator); const afterRestart = await cloudwatch.send(new DescribeAnomalyDetectorsCommand({ AnomalyDetectorTypes: ["METRIC_MATH"] })); assert.equal(afterRestart.AnomalyDetectors?.[0].AnomalyDetectorId, math.AnomalyDetectorId); assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  } finally { cloudwatch?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});
