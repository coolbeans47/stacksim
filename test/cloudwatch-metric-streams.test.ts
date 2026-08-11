import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CloudWatchClient,
  DeleteMetricStreamCommand,
  GetMetricStreamCommand,
  ListMetricStreamsCommand,
  ListTagsForResourceCommand,
  PutMetricDataCommand,
  PutMetricStreamCommand,
  StartMetricStreamsCommand,
  StopMetricStreamsCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from "@aws-sdk/client-cloudwatch";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";
import { TestClock } from "../src/core/clock.js";

const region = "eu-west-1";
const roleArn = "arn:aws:iam::000000000000:role/metric-stream-delivery";
const clientFor = (simulator: StackSim) => new CloudWatchClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
const invalid = (promise: Promise<unknown>, name = /InvalidParameter/) => assert.rejects(promise, (error: any) => name.test(error.name));

test("CW-08E metric streams implement lifecycle, filters, statistics, tags, local JSON delivery, Query XML, and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cw08e-")); const output = await mkdtemp(join(tmpdir(), "stacksim-cw08e-output-")); const clock = new TestClock(Date.parse("2026-07-17T12:00:00Z")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, allowLocalFiles: true, authMode: "off"}); let cloudwatch: CloudWatchClient | undefined;
  try {
    await simulator.start(); cloudwatch = clientFor(simulator); const destination = pathToFileURL(output).href;
    const created = await cloudwatch.send(new PutMetricStreamCommand({ Name: "local-metrics", FirehoseArn: destination, RoleArn: roleArn, OutputFormat: "json", IncludeFilters: [{ Namespace: "Learning/Stream", MetricNames: ["Requests"] }], StatisticsConfigurations: [{ IncludeMetrics: [{ Namespace: "Learning/Stream", MetricName: "Requests" }], AdditionalStatistics: ["p90", "p99"] }], Tags: [{ Key: "team", Value: "platform" }] }));
    assert.equal(created.Arn, "arn:aws:cloudwatch:eu-west-1:000000000000:metric-stream/local-metrics"); let described = await cloudwatch.send(new GetMetricStreamCommand({ Name: "local-metrics" })); assert.equal(described.State, "running"); assert.equal(described.OutputFormat, "json"); assert.deepEqual(described.IncludeFilters, [{ Namespace: "Learning/Stream", MetricNames: ["Requests"] }]); assert.deepEqual(described.StatisticsConfigurations?.[0].AdditionalStatistics, ["p90", "p99"]);

    await cloudwatch.send(new PutMetricDataCommand({ Namespace: "Learning/Stream", MetricData: [{ MetricName: "Requests", Dimensions: [{ Name: "Route", Value: "/orders" }], Timestamp: new Date(clock.now()), Values: [1, 9], Counts: [1, 1], Unit: "Count" }, { MetricName: "Latency", Value: 50, Unit: "Milliseconds" }] }));
    const path = join(output, "local-metrics.jsonl"); let records = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line)); assert.equal(records.length, 1); assert.deepEqual(records[0], { metric_stream_name: "local-metrics", account_id: "000000000000", region, namespace: "Learning/Stream", metric_name: "Requests", dimensions: { Route: "/orders" }, timestamp: clock.now(), value: { count: 2, sum: 10, max: 9, min: 1, p90: 9, p99: 9 }, unit: "Count" });

    await cloudwatch.send(new StopMetricStreamsCommand({ Names: ["local-metrics"] })); clock.advance(60_000); await cloudwatch.send(new PutMetricDataCommand({ Namespace: "Learning/Stream", MetricData: [{ MetricName: "Requests", Value: 12 }] })); assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 1, "stopped streams do not backfill");
    await cloudwatch.send(new PutMetricStreamCommand({ Name: "local-metrics", FirehoseArn: destination, RoleArn: roleArn, OutputFormat: "json", ExcludeFilters: [{ Namespace: "Learning/Internal" }], Tags: [{ Key: "ignored", Value: "on-update" }] })); described = await cloudwatch.send(new GetMetricStreamCommand({ Name: "local-metrics" })); assert.equal(described.State, "stopped", "updates preserve state"); assert.deepEqual((await cloudwatch.send(new ListTagsForResourceCommand({ ResourceARN: created.Arn! }))).Tags, [{ Key: "team", Value: "platform" }], "update tags are ignored");
    await cloudwatch.send(new TagResourceCommand({ ResourceARN: created.Arn!, Tags: [{ Key: "environment", Value: "local" }] })); await cloudwatch.send(new UntagResourceCommand({ ResourceARN: created.Arn!, TagKeys: ["team"] })); assert.deepEqual((await cloudwatch.send(new ListTagsForResourceCommand({ ResourceARN: created.Arn! }))).Tags, [{ Key: "environment", Value: "local" }]);
    await cloudwatch.send(new StartMetricStreamsCommand({ Names: ["local-metrics"] })); clock.advance(60_000); await cloudwatch.send(new PutMetricDataCommand({ Namespace: "Learning/Stream", MetricData: [{ MetricName: "Latency", Value: 25, Unit: "Milliseconds" }] })); records = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line)); assert.equal(records.length, 2); assert.equal(records[1].metric_name, "Latency");

    await cloudwatch.send(new PutMetricStreamCommand({ Name: "firehose-descriptor", FirehoseArn: "arn:aws:firehose:eu-west-1:000000000000:deliverystream/metrics", RoleArn: roleArn, OutputFormat: "opentelemetry1.0" })); const firstPage = await cloudwatch.send(new ListMetricStreamsCommand({ MaxResults: 1 })); assert.equal(firstPage.Entries?.length, 1); assert.ok(firstPage.NextToken); const secondPage = await cloudwatch.send(new ListMetricStreamsCommand({ MaxResults: 1, NextToken: firstPage.NextToken })); assert.equal(secondPage.Entries?.length, 1); assert.deepEqual([...firstPage.Entries!, ...secondPage.Entries!].map(item => item.Name).sort(), ["firehose-descriptor", "local-metrics"]);
    await assert.rejects(cloudwatch.send(new StopMetricStreamsCommand({ Names: ["local-metrics", "missing"] })), (error: any) => error.name === "ResourceNotFoundException"); assert.equal((await cloudwatch.send(new GetMetricStreamCommand({ Name: "local-metrics" }))).State, "running", "batch transition is atomic");

    await invalid(cloudwatch.send(new PutMetricStreamCommand({ Name: "both", FirehoseArn: destination, RoleArn: roleArn, OutputFormat: "json", IncludeFilters: [{ Namespace: "A" }], ExcludeFilters: [{ Namespace: "B" }] })));
    await invalid(cloudwatch.send(new PutMetricStreamCommand({ Name: "linked", FirehoseArn: destination, RoleArn: roleArn, OutputFormat: "json", IncludeLinkedAccountsMetrics: true })));
    await invalid(cloudwatch.send(new PutMetricStreamCommand({ Name: "otel-file", FirehoseArn: destination, RoleArn: roleArn, OutputFormat: "opentelemetry1.0" })));
    await invalid(cloudwatch.send(new PutMetricStreamCommand({ Name: "trimmed-local", FirehoseArn: destination, RoleArn: roleArn, OutputFormat: "json", StatisticsConfigurations: [{ IncludeMetrics: [{ Namespace: "Learning/Stream", MetricName: "Requests" }], AdditionalStatistics: ["tm90"] }] })));

    const response = await fetch(`http://127.0.0.1:${simulator.port}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ Action: "GetMetricStream", Version: "2010-08-01", Name: "local-metrics" }) }); const xml = await response.text(); assert.equal(response.status, 200); assert.match(xml, /<Name>local-metrics<\/Name>/); assert.match(xml, /<State>running<\/State>/); assert.match(xml, /<OutputFormat>json<\/OutputFormat>/);

    cloudwatch.destroy(); cloudwatch = undefined; await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, allowLocalFiles: true, authMode: "off"}); await simulator.start(); cloudwatch = clientFor(simulator); assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION); assert.equal((await cloudwatch.send(new GetMetricStreamCommand({ Name: "local-metrics" }))).State, "running"); assert.equal(simulator.store.regionState(region).cloudwatch.metricStreams["local-metrics"].deliveredRecords, 2);
    await cloudwatch.send(new DeleteMetricStreamCommand({ Name: "local-metrics" })); await assert.rejects(cloudwatch.send(new DeleteMetricStreamCommand({ Name: "missing" })), (error: any) => error.name === "ResourceNotFoundException"); await assert.rejects(cloudwatch.send(new GetMetricStreamCommand({ Name: "local-metrics" })), (error: any) => error.name === "ResourceNotFoundException");
  } finally { cloudwatch?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); }
});
