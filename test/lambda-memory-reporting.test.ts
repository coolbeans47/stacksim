import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateFunctionCommand, GetFunctionConfigurationCommand, InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { createZip } from "../src/core/zip-create.js";
import { measureWorkerMemory } from "../src/lambda-memory.js";
import { StackSim } from "../src/server.js";

test("memory measurement converts Node KiB and never invents unavailable measurements", () => {
  assert.equal((measureWorkerMemory(() => ({ maxRSS: 2048 }) as NodeJS.ResourceUsage) as any).maxMemoryUsedMB, 2);
  for (const maxRSS of [0, NaN, Infinity, -1]) assert.equal(measureWorkerMemory(() => ({ maxRSS }) as NodeJS.ResourceUsage).status, "unavailable");
  assert.equal(measureWorkerMemory(() => { throw new Error("unsupported host"); }).status, "unavailable");
});

test("Lambda SDK text/JSON REPORT uses worker lifetime peak RSS across warm calls and honest exit/image fallbacks", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-memory-report-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off" });
  let client: LambdaClient | undefined;
  try {
    await simulator.start();
    client = new LambdaClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
    const code = createZip([{ name: "index.js", content: `let retained; exports.handler = async event => { if (event.crash) process.exit(3); if (event.grow) retained = Buffer.alloc(24 * 1024 * 1024, 7); return { pid: process.pid, peakMB: process.resourceUsage().maxRSS / 1024 }; };` }]);
    for (const format of ["Text", "JSON"] as const) {
      const name = `memory-${format}`;
      await client.send(new CreateFunctionCommand({ FunctionName: name, Runtime: "nodejs22.x", Role: "arn:aws:iam::000000000000:role/test", Handler: "index.handler", MemorySize: 10240, Code: { ZipFile: code }, LoggingConfig: { LogFormat: format } }));
      for (let i = 0; i < 100; i++) { if ((await client.send(new GetFunctionConfigurationCommand({ FunctionName: name }))).State === "Active") break; await new Promise(resolve => setTimeout(resolve, 10)); }
      const reports: number[] = []; const pids: number[] = [];
      for (const event of [{ grow: true }, {}]) {
        const response: any = await client.send(new InvokeCommand({ FunctionName: name, Payload: Buffer.from(JSON.stringify(event)), LogType: "Tail" }));
        assert.equal(response.FunctionError, undefined);
        const payload = JSON.parse(Buffer.from(response.Payload!).toString()); pids.push(payload.pid);
        const logs = Buffer.from(response.LogResult!, "base64").toString();
        const report = format === "JSON" ? logs.trim().split("\n").map(line => JSON.parse(line)).find(line => line.type === "platform.report").record : undefined;
        const peak = report ? report.metrics.maxMemoryUsedMB : Number(/Max Memory Used: ([\d.]+) MB/.exec(logs)?.[1]);
        assert.ok(peak > 0 && peak !== 10240); assert.ok(peak + 0.01 >= payload.peakMB);
        if (report) { assert.equal(report.metrics.memorySizeMB, 10240); assert.equal(report.memoryUsage.scope, "worker-lifetime-excluding-children"); assert.equal(report.resourceLimits.memory, "descriptor-only"); }
        else assert.match(logs, /worker lifetime peak RSS; excludes child processes/);
        reports.push(peak);
      }
      assert.equal(pids[0], pids[1]); assert.ok(reports[1] >= reports[0]);
      const crashed: any = await client.send(new InvokeCommand({ FunctionName: name, Payload: Buffer.from('{"crash":true}'), LogType: "Tail" }));
      const logs = Buffer.from(crashed.LogResult!, "base64").toString(); assert.equal(crashed.FunctionError, "Unhandled");
      if (format === "JSON") { const report = logs.trim().split("\n").map(line => JSON.parse(line)).find(line => line.type === "platform.report").record; assert.equal(report.metrics.maxMemoryUsedMB, undefined); assert.equal(report.memoryUsage.reason, "worker-ended-without-measurement"); }
      else assert.match(logs, /Max Memory Used: unavailable/);
      // Image runtime deliberately supplies no worker-process measurement.
      const lines: string[] = (simulator.lambda as any).formatLogLines({ packageType: "Image", memorySize: 512, loggingConfig: { logFormat: format } }, "image", "request", "$LATEST", 5, 5, []);
      if (format === "JSON") { const report = lines.map(line => JSON.parse(line)).find(line => line.type === "platform.report").record; assert.equal(report.metrics.maxMemoryUsedMB, undefined); assert.equal(report.memoryUsage.reason, "container-peak-unavailable"); assert.equal(report.resourceLimits.memory, "docker-limit-requested"); }
      else assert.match(lines.join("\n"), /Max Memory Used: unavailable \(container-peak-unavailable\)/);
    }
  } finally { client?.destroy(); await simulator.stop(); await rm(root, { recursive: true, force: true }); }
});
