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

for (const boundary of ["intent-committed", "object-committed"]) test(`acknowledged snapshot recovers after forced process termination at ${boundary}`, { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-snapshot-crash-")), extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const child = fork(new URL(`./fixtures/opensearch-snapshot-crash.${extension}`, import.meta.url), [root, boundary], { execArgv: extension === "ts" ? ["--import", "tsx"] : [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = ""; child.stderr?.on("data", data => { errors += data; }); const exited = once(child, "exit");
  let sim: StackSim | undefined, client: Client | undefined;
  try {
    const signal = await Promise.race([once(child, "message"), exited.then(() => { throw new Error(`Snapshot child exited early: ${errors}`); }), delay(15000, undefined, { ref: false }).then(() => { throw new Error(`Timed out: ${errors}`); })]);
    assert.equal(signal[0].boundary, boundary); assert.equal(signal[0].accepted, true); child.kill("SIGKILL"); await exited;
    sim = new StackSim({ dataDir: root, port: 0, invokePort: 0, authMode: "enforce", cdkBootstrap: false }); await sim.start();
    const region = "eu-west-1", domain = sim.opensearch.domain(region, "snapshot-recovery"), ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath);
    client = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => ({ accessKeyId: "admin", secretAccessKey: "password" }) }) });
    let state: string | undefined;
    for (let i = 0; i < 200; i++) { state = (await client.snapshot.get({ repository: "backups", snapshot: "durable" })).body.snapshots[0].state; if (state === "SUCCESS") break; await delay(10); }
    assert.equal(state, "SUCCESS");
    await client.snapshot.restore({ repository: "backups", snapshot: "durable", wait_for_completion: true, body: { rename_pattern: "(.+)", rename_replacement: "restored-$1" } });
    assert.equal((await client.get({ index: "restored-records", id: "one" })).body._source.value, "durable-snapshot-data");
    assert.equal((await client.snapshot.get({ repository: "backups", snapshot: "_all" })).body.snapshots.length, 1);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } await client?.close(); await sim?.stop(); await rm(root, { recursive: true, force: true }); }
});
