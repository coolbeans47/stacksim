import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudWatchClient, DeleteDashboardsCommand, GetDashboardCommand, GetMetricWidgetImageCommand, ListDashboardsCommand, PutDashboardCommand } from "@aws-sdk/client-cloudwatch";
import { TestClock } from "../src/core/clock.js";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
function client(simulator: StackSim, region = "eu-west-1"): CloudWatchClient { return new CloudWatchClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials }); }

test("CloudWatch dashboard SDK supports validation, global round-trip, listing, deletion, XML, unsupported images, and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-dashboards-")); const clock = new TestClock(Date.parse("2026-07-16T12:00:00Z")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); let primary: CloudWatchClient | undefined; let other: CloudWatchClient | undefined;
  const body = JSON.stringify({
    start: "-PT3H", periodOverride: "inherit",
    variables: [{ type: "property", property: "Route", inputType: "select", id: "route", defaultValue: "/notes", values: [{ label: "Notes", value: "/notes" }, { value: "/health" }] }],
    widgets: [
      { type: "text", x: 0, y: 0, width: 24, height: 2, properties: { markdown: "# Local operations" } },
      { type: "metric", x: 0, y: 2, width: 12, height: 6, properties: { title: "Latency", region: "eu-west-1", metrics: [["Learning/App", "Latency", "Route", "/notes", { id: "latency" }]], stat: "Average", period: 60, view: "timeSeries", localHint: "round-trip" } },
      { type: "metric", x: 12, y: 2, width: 4, height: 6, properties: { title: "Latest", region: "eu-west-1", metrics: [["Learning/App", "Latency"]], view: "singleValue" } },
      { type: "metric", x: 16, y: 2, width: 4, height: 6, properties: { title: "Gauge", region: "eu-west-1", metrics: [["Learning/App", "Latency"]], view: "gauge" } },
      { type: "metric", x: 20, y: 2, width: 4, height: 6, properties: { title: "Pie", region: "eu-west-1", metrics: [["Learning/App", "Latency"]], view: "pie" } },
      { type: "log", x: 0, y: 8, width: 12, height: 6, properties: { title: "Errors", region: "eu-west-1", query: "SOURCE '/aws/lambda/worker' | fields @timestamp, @message | limit 20" } },
      { type: "alarm", x: 12, y: 8, width: 12, height: 6, properties: { title: "Alarm status", alarms: ["arn:aws:cloudwatch:eu-west-1:000000000000:alarm:latency"] } },
      { type: "explorer", x: 0, y: 14, width: 12, height: 6, properties: { title: "Lambda requests", labels: ["FunctionName"], metrics: [{ metricName: "Invocations", resourceType: "AWS::Lambda::Function", stat: "Sum" }] } },
      { type: "custom", x: 12, y: 14, width: 12, height: 6, properties: { preserved: true } },
    ],
  });
  try {
    await simulator.start(); primary = client(simulator); other = client(simulator, "us-east-1");
    const put = await primary.send(new PutDashboardCommand({ DashboardName: "operations_local", DashboardBody: body, Tags: [{ Key: "team", Value: "platform" }] }));
    assert.deepEqual(put.DashboardValidationMessages?.map(item => item.DataPath), ["$.widgets[1].properties.localHint", "$.widgets[8].type"]);
    const got = await other.send(new GetDashboardCommand({ DashboardName: "operations_local" })); assert.equal(got.DashboardName, "operations_local"); assert.equal(got.DashboardBody, body); assert.equal(got.DashboardArn, "arn:aws:cloudwatch::000000000000:dashboard/operations_local");
    const listed = await primary.send(new ListDashboardsCommand({ DashboardNamePrefix: "operations" })); assert.equal(listed.DashboardEntries?.length, 1); assert.equal(listed.DashboardEntries?.[0].Size, Buffer.byteLength(body)); assert.deepEqual(listed.DashboardEntries?.[0].LastModified, new Date(clock.now()));
    await assert.rejects(primary.send(new PutDashboardCommand({ DashboardName: "invalid.name", DashboardBody: body })), (error: any) => error.name === "InvalidParameterValueException");
    await assert.rejects(primary.send(new PutDashboardCommand({ DashboardName: "bad_json", DashboardBody: "{" })), (error: any) => error.name === "DashboardInvalidInputError");
    await assert.rejects(primary.send(new PutDashboardCommand({ DashboardName: "bad_grid", DashboardBody: JSON.stringify({ widgets: [{ type: "text", x: 20, y: 0, width: 6, properties: { markdown: "bad" } }] }) })), (error: any) => error.name === "DashboardInvalidInputError");
    await assert.rejects(primary.send(new GetMetricWidgetImageCommand({ MetricWidget: JSON.stringify({ metrics: [["Learning/App", "Latency"]] }) })), (error: any) => error.name === "UnsupportedOperation");

    const raw = await fetch(`http://127.0.0.1:${simulator.port}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-stacksim-region": "eu-west-1" }, body: new URLSearchParams({ Action: "GetDashboard", Version: "2010-08-01", DashboardName: "operations_local" }) }); const xml = await raw.text(); assert.equal(raw.status, 200); assert.match(xml, /<GetDashboardResponse xmlns="http:\/\/monitoring\.amazonaws\.com\/doc\/2010-08-01\/">/); assert.match(xml, /<DashboardName>operations_local<\/DashboardName>/);

    primary.destroy(); other.destroy(); primary = other = undefined; await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); await simulator.start(); primary = client(simulator);
    assert.equal((await primary.send(new GetDashboardCommand({ DashboardName: "operations_local" }))).DashboardBody, body); assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    await primary.send(new DeleteDashboardsCommand({ DashboardNames: ["operations_local", "not_present"] })); assert.equal((await primary.send(new ListDashboardsCommand({}))).DashboardEntries?.length, 0);
    await assert.rejects(primary.send(new GetDashboardCommand({ DashboardName: "operations_local" })), (error: any) => ["DashboardNotFoundError", "ResourceNotFound"].includes(error.name));
    await assert.rejects(primary.send(new DeleteDashboardsCommand({ DashboardNames: [] })), (error: any) => error.name === "InvalidParameterValueException");
  } finally { primary?.destroy(); other?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
