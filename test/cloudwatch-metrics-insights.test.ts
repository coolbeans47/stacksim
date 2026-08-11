import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AssociateDatasetKmsKeyCommand,
  CloudWatchClient,
  DisassociateDatasetKmsKeyCommand,
  GetDatasetCommand,
  GetMetricDataCommand,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import { TestClock } from "../src/core/clock.js";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
function client(simulator: StackSim): CloudWatchClient { return new CloudWatchClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials }); }

test("CW-08D Metrics Insights groups, orders, limits, composes with arithmetic, and persists the default dataset descriptor", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-metrics-insights-")); const clock = new TestClock(Date.parse("2026-07-17T12:03:00Z")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); let cloudwatch: CloudWatchClient | undefined;
  try {
    await simulator.start(); cloudwatch = client(simulator);
    const at = (minute: number) => new Date(Date.parse(`2026-07-17T12:0${minute}:05Z`));
    await cloudwatch.send(new PutMetricDataCommand({ Namespace: "Learning/Insights", MetricData: [
      { MetricName: "Requests", Dimensions: [{ Name: "Service", Value: "orders" }, { Name: "Host", Value: "api-a" }], Timestamp: at(0), Value: 5 },
      { MetricName: "Requests", Dimensions: [{ Name: "Host", Value: "api-a" }, { Name: "Service", Value: "orders" }], Timestamp: at(1), Value: 7 },
      { MetricName: "Requests", Dimensions: [{ Name: "Service", Value: "orders" }, { Name: "Host", Value: "api-b" }], Timestamp: at(0), Value: 3 },
      { MetricName: "Requests", Dimensions: [{ Name: "Service", Value: "orders" }, { Name: "Host", Value: "api-b" }], Timestamp: at(1), Value: 9 },
      { MetricName: "Requests", Dimensions: [{ Name: "Service", Value: "orders" }, { Name: "Host", Value: "api-c" }], Timestamp: at(0), Value: 2 },
      { MetricName: "Requests", Dimensions: [{ Name: "Service", Value: "orders" }, { Name: "Host", Value: "api-c" }], Timestamp: at(1), Value: 1 },
      { MetricName: "Requests", Dimensions: [{ Name: "Service", Value: "payments" }, { Name: "Host", Value: "api-c" }], Timestamp: at(0), Value: 100 },
    ] }));
    const start = new Date("2026-07-17T12:00:00Z"); const end = new Date("2026-07-17T12:02:00Z"); const sql = `SELECT SUM(Requests) FROM SCHEMA("Learning/Insights", Service, Host) WHERE Service = 'orders' GROUP BY Host ORDER BY MAX() DESC LIMIT 2`;
    const grouped = await cloudwatch.send(new GetMetricDataCommand({ StartTime: start, EndTime: end, ScanBy: "TimestampAscending", MetricDataQueries: [{ Id: "requests", Label: "Requests by host", Expression: sql, Period: 60 }] }));
    assert.deepEqual(grouped.MetricDataResults?.map(result => result.Label), ["Requests by host (Host=api-b)", "Requests by host (Host=api-a)"]);
    assert.deepEqual(grouped.MetricDataResults?.map(result => result.Values), [[3, 9], [5, 7]]);

    const arithmetic = await cloudwatch.send(new GetMetricDataCommand({ StartTime: start, EndTime: end, ScanBy: "TimestampAscending", MetricDataQueries: [
      { Id: "requests", ReturnData: false, Expression: sql, Period: 60 },
      { Id: "scaled", Label: "Requests in tens", Expression: "requests / 10" },
    ] }));
    assert.deepEqual(arithmetic.MetricDataResults?.map(result => result.Label), ["Requests in tens (Host=api-b)", "Requests in tens (Host=api-a)"]);
    assert.deepEqual(arithmetic.MetricDataResults?.map(result => result.Values), [[0.3, 0.9], [0.5, 0.7]]);

    const total = await cloudwatch.send(new GetMetricDataCommand({ StartTime: start, EndTime: end, ScanBy: "TimestampAscending", MetricDataQueries: [{ Id: "count", Expression: `SELECT COUNT(Requests) FROM "Learning/Insights" WHERE Service != 'payments'`, Period: 60 }] }));
    assert.deepEqual(total.MetricDataResults?.[0].Values, [3, 3]);
    await assert.rejects(cloudwatch.send(new GetMetricDataCommand({ StartTime: start, EndTime: end, MetricDataQueries: [{ Id: "one", Expression: sql, Period: 60 }, { Id: "two", Expression: sql, Period: 60 }] })), (error: any) => error.name === "InvalidParameterValueException" && /only one/.test(error.message));
    await assert.rejects(cloudwatch.send(new GetMetricDataCommand({ StartTime: start, EndTime: end, MetricDataQueries: [{ Id: "tagged", Expression: `SELECT SUM(Requests) FROM "Learning/Insights" WHERE tag.Team = 'orders'`, Period: 60 }] })), (error: any) => error.name === "InvalidParameterValueException" && /Resource-tag/.test(error.message));
    await assert.rejects(cloudwatch.send(new GetMetricDataCommand({ StartTime: new Date("2026-07-17T08:00:00Z"), EndTime: new Date("2026-07-17T09:00:00Z"), MetricDataQueries: [{ Id: "old", Expression: sql, Period: 60 }] })), (error: any) => error.name === "InvalidParameterValueException" && /three hours/.test(error.message));

    const datasetArn = "arn:aws:cloudwatch:eu-west-1:000000000000:dataset/default"; const kmsArn = "arn:aws:kms:eu-west-1:000000000000:key/12345678-abcd-1234-abcd-1234567890ab";
    const dataset = await cloudwatch.send(new GetDatasetCommand({ DatasetIdentifier: "default" })); assert.equal(dataset.DatasetId, "default"); assert.equal(dataset.Arn, datasetArn); assert.equal(dataset.KmsKeyArn, undefined);
    await assert.rejects(cloudwatch.send(new DisassociateDatasetKmsKeyCommand({ DatasetIdentifier: "default" })), (error: any) => error.name === "ResourceNotFoundException");
    await cloudwatch.send(new AssociateDatasetKmsKeyCommand({ DatasetIdentifier: datasetArn, KmsKeyArn: kmsArn }));
    assert.equal((await cloudwatch.send(new GetDatasetCommand({ DatasetIdentifier: "default" }))).KmsKeyArn, kmsArn);
    await assert.rejects(cloudwatch.send(new AssociateDatasetKmsKeyCommand({ DatasetIdentifier: "default", KmsKeyArn: "arn:aws:kms:us-east-1:000000000000:key/wrong-region" })), (error: any) => error.name === "InvalidParameterValueException");

    const raw = await fetch(`http://127.0.0.1:${simulator.port}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-stacksim-region": "eu-west-1" }, body: new URLSearchParams({ Action: "GetDataset", Version: "2010-08-01", DatasetIdentifier: "default" }) }); const xml = await raw.text(); assert.equal(raw.status, 200); assert.match(xml, /<DatasetId>default<\/DatasetId>/); assert.match(xml, /<KmsKeyArn>arn:aws:kms:eu-west-1:000000000000:key\/12345678/);

    cloudwatch.destroy(); cloudwatch = undefined; await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); await simulator.start(); cloudwatch = client(simulator);
    assert.equal((await cloudwatch.send(new GetDatasetCommand({ DatasetIdentifier: "default" }))).KmsKeyArn, kmsArn); assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION); await cloudwatch.send(new DisassociateDatasetKmsKeyCommand({ DatasetIdentifier: "default" })); assert.equal((await cloudwatch.send(new GetDatasetCommand({ DatasetIdentifier: "default" }))).KmsKeyArn, undefined);
  } finally { cloudwatch?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
