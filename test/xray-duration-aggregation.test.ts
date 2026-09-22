import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { XRayClient, PutTraceSegmentsCommand, GetTraceGraphCommand, GetServiceGraphCommand } from "@aws-sdk/client-xray";
import { StackSim } from "../src/server.js";

test("X-Ray SDK graphs sum unique completed requests and child edges independently of observation windows", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-xray-duration-")); const sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off" }); let client: XRayClient | undefined;
  try {
    await sim.start(); client = new XRayClient({ endpoint: `http://127.0.0.1:${sim.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
    const start = Math.floor(Date.now() / 1000) - 7200;
    const ids = [1, 2, 3, 4].map(n => `1-${Math.floor(start).toString(16).padStart(8, "0")}-${n.toString(16).padStart(24, "0")}`);
    const document = (n: number, extra: any = {}) => ({ trace_id: ids[n - 1], id: "0000000000000001", name: "api", start_time: start, end_time: start + 1, ...extra });
    const put = async (...documents: any[]) => { const result = await client!.send(new PutTraceSegmentsCommand({ TraceSegmentDocuments: documents.map(value => JSON.stringify(value)) })); assert.deepEqual(result.UnprocessedTraceSegments, []); };
    const child = { id: "0000000000000002", name: "database", start_time: start + 0.25, end_time: start + 0.75, namespace: "aws" };
    const first = document(1, { subsegments: [child] });
    await put(first, document(2, { start_time: start + 3600, end_time: start + 3601 }));
    let graph = await client.send(new GetTraceGraphCommand({ TraceIds: ids.slice(0, 2) }));
    let api = graph.Services!.find(node => node.Name === "api")!;
    assert.equal(api.SummaryStatistics!.TotalResponseTime, 2); assert.equal(api.SummaryStatistics!.TotalCount, 2);
    assert.equal(api.EndTime!.getTime() - api.StartTime!.getTime(), 3601000);
    assert.equal(api.Edges![0].SummaryStatistics!.TotalResponseTime, 0.5); assert.equal(api.Edges![0].SummaryStatistics!.TotalCount, 1);
    // Same document retry and embedded/independent representation of a child.
    await put(first, { ...child, type: "subsegment", parent_id: first.id, trace_id: ids[0] });
    await put(document(3, { start_time: start + 0.5, end_time: start + 1.5, error: true, fault: true, throttle: true }), document(4, { end_time: undefined, in_progress: true }));
    graph = await client.send(new GetTraceGraphCommand({ TraceIds: [...ids, ids[0]] })); api = graph.Services!.find(node => node.Name === "api")!;
    assert.equal(api.SummaryStatistics!.TotalCount, 3); assert.equal(api.SummaryStatistics!.TotalResponseTime, 3); assert.equal(api.SummaryStatistics!.FaultStatistics!.TotalCount, 1);
    assert.equal(graph.Services!.find(node => node.Name === "database")!.SummaryStatistics!.TotalCount, 1); assert.equal(api.Edges![0].SummaryStatistics!.TotalCount, 1);
    await put(document(4, { end_time: start + 2, http: { response: { status: 429 } } }));
    const window = await client.send(new GetServiceGraphCommand({ StartTime: new Date(start * 1000), EndTime: new Date((start + 4000) * 1000) }));
    api = window.Services!.find(node => node.Name === "api")!;
    assert.equal(api.SummaryStatistics!.TotalCount, 4); assert.equal(api.SummaryStatistics!.TotalResponseTime, 5); assert.equal(api.SummaryStatistics!.ErrorStatistics!.ThrottleCount, 1);
    assert.deepEqual((await client.send(new GetTraceGraphCommand({ TraceIds: ids }))).Services, window.Services);
    // A separately ingested child must link even if ingested before its parent.
    const nested = { ...child, id: "0000000000000003", name: "cache", parent_id: child.id, type: "subsegment", trace_id: ids[0] };
    await put(nested, nested);
    graph = await client.send(new GetTraceGraphCommand({ TraceIds: [ids[0]] }));
    assert.equal(graph.Services!.find(node => node.Name === "database")!.Edges![0].SummaryStatistics!.TotalResponseTime, 0.5);
  } finally { client?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
