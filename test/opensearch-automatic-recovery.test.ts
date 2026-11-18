import assert from "node:assert/strict";
import { test } from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { StackSim } from "../src/server.js";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";

for (const boundary of ["before-catalog", "after-catalog"]) test(`automatic backup recovers protected publication after process termination ${boundary}`, { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-automatic-crash-")), extension = import.meta.url.endsWith(".ts") ? "ts" : "js", child = fork(new URL(`./fixtures/opensearch-automatic-crash.${extension}`, import.meta.url), [root, boundary], { execArgv: extension === "ts" ? ["--import", "tsx"] : [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = ""; child.stderr?.on("data", data => { errors += data; }); const exited = once(child, "exit"); let sim: StackSim | undefined, client: Client | undefined;
  try {
    const [signal] = await Promise.race([once(child, "message"), exited.then(() => { throw new Error(`Automatic child exited: ${errors}`); }), delay(15000, undefined, { ref: false }).then(() => { throw new Error(`Timed out: ${errors}`); })]); assert.equal(signal.boundary, boundary); child.kill("SIGKILL"); await exited;
    const region = "eu-west-1"; sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, cdkBootstrap: false, authMode: "enforce" }); await sim.start(); const domain = sim.opensearch.domain(region, "automatic-recovery");
    if (boundary === "before-catalog") { assert.equal(domain.automaticBackups?.items.length ?? 0, 0); assert.equal((await readdir(join(root, "secrets", "opensearch-backups-materials"))).length, 0); await (sim.opensearch as any).automaticBackups.tick(); } else assert.equal(domain.automaticBackups!.items[0].name, signal.name);
    assert.equal(domain.automaticBackups!.items.length, 1); assert.equal((await readdir(join(root, "secrets", "opensearch-backups-intents"))).length, 0);
    client = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath) }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => ({ accessKeyId: "admin", secretAccessKey: "password" }) }) }); await client.snapshot.restore({ repository: "cs-automated-enc", snapshot: domain.automaticBackups!.items[0].name, wait_for_completion: true, body: { rename_pattern: "(.+)", rename_replacement: "recovered-$1" } }); assert.equal((await client.get({ index: "recovered-records", id: "one" })).body._source.title, "automatic-crash-source");
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } await client?.close(); await sim?.stop(); await rm(root, { recursive: true, force: true }); }
});
