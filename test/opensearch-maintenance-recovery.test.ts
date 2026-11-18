import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { StackSim } from "../src/server.js";

for (const boundary of ["intent-published", "storage-reopened"]) test(`maintenance resumes after forced termination at ${boundary}`, { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-maintenance-crash-")), extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const child = fork(new URL(`./fixtures/opensearch-maintenance-crash.${extension}`, import.meta.url), [root, boundary], { execArgv: extension === "ts" ? ["--import", "tsx"] : [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = ""; child.stderr?.on("data", data => { errors += data; }); const exited = once(child, "exit");
  let sim: StackSim | undefined, client: Client | undefined;
  try {
    const signal = await Promise.race([once(child, "message"), exited.then(() => { throw new Error(`Maintenance child exited early: ${errors}`); }), delay(15000, undefined, { ref: false }).then(() => { throw new Error(`Timed out: ${errors}`); })]);
    assert.equal(signal[0].boundary, boundary); assert.ok(signal[0].id); child.kill("SIGKILL"); await exited;
    sim = new StackSim({ dataDir: root, port: 0, invokePort: 0, authMode: "enforce", cdkBootstrap: false }); await sim.start();
    const region = "eu-west-1", domain = sim.opensearch.domain(region, "maintenance-recovery"), ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath);
    for (let i = 0; i < 200 && domain.maintenances?.at(-1)?.state !== "COMPLETED"; i++) await delay(10);
    assert.equal(domain.maintenances?.length, 1); assert.equal(domain.maintenances[0].id, signal[0].id); assert.equal(domain.maintenances[0].state, "COMPLETED");
    client = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => ({ accessKeyId: "admin", secretAccessKey: "password" }) }) });
    assert.equal((await client.get({ index: "records", id: "one" })).body._source.value, "maintenance-crash-preserved");
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } await client?.close(); await sim?.stop(); await rm(root, { recursive: true, force: true }); }
});
