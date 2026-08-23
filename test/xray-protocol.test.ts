import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateAccessKeyCommand, CreateUserCommand, IAMClient } from "@aws-sdk/client-iam";
import { BatchGetTracesCommand, GetSamplingRulesCommand, GetServiceGraphCommand, GetTraceGraphCommand, GetTraceSummariesCommand, PutTraceSegmentsCommand, XRayClient } from "@aws-sdk/client-xray";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const admin = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";

function segment(index: number, options: Record<string, unknown> = {}): string {
  const suffix = index.toString(16).padStart(24, "0"); const id = index.toString(16).padStart(16, "0");
  return JSON.stringify({ name: index % 2 ? "orders" : "payments", trace_id: `1-66aa0000-${suffix}`, id, start_time: 1_000 + index, end_time: 1_000.25 + index, annotations: { release: index % 2 ? "blue" : "green" }, http: { response: { status: index === 2 ? 500 : 200 } }, ...(index === 2 ? { fault: true } : {}), ...options });
}

test("XRY-01 official SDK writes partial batches and reads summaries, traces, filters, graphs, and protected page tokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-xray-protocol-")); const clock = new TestClock(2_000_000); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" }); let client: XRayClient | undefined;
  try {
    await simulator.start(); client = new XRayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials: admin, maxAttempts: 1 });
    const partial = await client.send(new PutTraceSegmentsCommand({ TraceSegmentDocuments: [segment(1), "{not-json"] }));
    assert.equal(partial.UnprocessedTraceSegments?.length, 1); assert.equal(partial.UnprocessedTraceSegments?.[0].ErrorCode, "InvalidRequestException");
    await client.send(new PutTraceSegmentsCommand({ TraceSegmentDocuments: [segment(2), ...Array.from({ length: 49 }, (_, offset) => segment(offset + 3))] }));
    await client.send(new PutTraceSegmentsCommand({ TraceSegmentDocuments: Array.from({ length: 50 }, (_, offset) => segment(offset + 52)) }));
    const first = await client.send(new GetTraceSummariesCommand({ StartTime: new Date(0), EndTime: new Date(3_000_000) }));
    assert.equal(first.TraceSummaries?.length, 100); assert.ok(first.NextToken);
    const second = await client.send(new GetTraceSummariesCommand({ StartTime: new Date(0), EndTime: new Date(3_000_000), NextToken: first.NextToken }));
    assert.equal(second.TraceSummaries?.length, 1);
    await assert.rejects(client.send(new GetTraceSummariesCommand({ StartTime: new Date(0), EndTime: new Date(3_000_000), NextToken: `${first.NextToken}x` })), (error: any) => error.name === "InvalidRequestException");
    const fault = await client.send(new GetTraceSummariesCommand({ StartTime: new Date(0), EndTime: new Date(3_000_000), FilterExpression: "fault" })); assert.equal(fault.TraceSummaries?.length, 1); assert.equal(fault.TraceSummaries?.[0].HasFault, true);
    await assert.rejects(client.send(new GetTraceSummariesCommand({ StartTime: new Date(0), EndTime: new Date(3_000_000), FilterExpression: "annotation.release = blue" })), (error: any) => error.name === "InvalidRequestException");
    const traceId = "1-66aa0000-000000000000000000000001";
    const traces = await client.send(new BatchGetTracesCommand({ TraceIds: [traceId, "1-66aa0000-ffffffffffffffffffffffff"] })); assert.equal(traces.Traces?.length, 1); assert.equal(traces.Traces?.[0].Segments?.[0].Id, "0000000000000001");
    const traceGraph = await client.send(new GetTraceGraphCommand({ TraceIds: [traceId] })); assert.equal(traceGraph.Services?.[0].Name, "orders");
    const serviceGraph = await client.send(new GetServiceGraphCommand({ StartTime: new Date(0), EndTime: new Date(3_000_000) })); assert.ok((serviceGraph.Services?.length ?? 0) >= 2);
    client.destroy(); await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" }); await simulator.start(); client = new XRayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials: admin, maxAttempts: 1 });
    assert.equal((await client.send(new BatchGetTracesCommand({ TraceIds: [traceId] }))).Traces?.length, 1, "official reads survive restart");
    const otherRegion = new XRayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "us-east-1", credentials: admin, maxAttempts: 1 });
    assert.equal((await otherRegion.send(new BatchGetTracesCommand({ TraceIds: [traceId] }))).Traces?.length, 0, "trace repositories are Region isolated"); otherRegion.destroy();
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("XRY-01 signed X-Ray operations map to exact IAM actions and later routes stay unsupported", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-xray-iam-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true }); const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; const iam = new IAMClient({ endpoint, region, credentials: admin, maxAttempts: 1 }); clients.push(iam); await iam.send(new CreateUserCommand({ UserName: "xray-denied" })); const key = (await iam.send(new CreateAccessKeyCommand({ UserName: "xray-denied" }))).AccessKey!;
    const denied = new XRayClient({ endpoint, region, credentials: { accessKeyId: key.AccessKeyId!, secretAccessKey: key.SecretAccessKey! }, maxAttempts: 1 }); clients.push(denied);
    await assert.rejects(denied.send(new PutTraceSegmentsCommand({ TraceSegmentDocuments: [segment(1)] })), (error: any) => error.name === "AccessDenied" || error.name === "AccessDeniedException");
    assert.equal(simulator.store.ensureAccount().iam.authorizationDecisions.at(-1)?.action, "xray:PutTraceSegments");
    const signed = new XRayClient({ endpoint, region, credentials: admin, maxAttempts: 1 }); clients.push(signed);
    await assert.rejects(signed.send(new GetSamplingRulesCommand({})), (error: any) => error.name === "InvalidRequestException" && /Unknown X-Ray operation/.test(error.message));
  } finally { clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
