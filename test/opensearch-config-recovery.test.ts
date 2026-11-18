import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { StackSim } from "../src/server.js";

for (const boundary of ["intent", "encrypted-ready", "publish"]) test(`encryption migration recovers after forced termination at ${boundary} without losing acknowledged data`, { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-os-migrate-crash-"));
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const child = fork(new URL(`./fixtures/opensearch-config-crash.${extension}`, import.meta.url), [root, boundary], { execArgv: extension === "ts" ? ["--import", "tsx"] : [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = "", sim: StackSim | undefined;
  child.stderr?.on("data", chunk => errors += chunk);
  const exit = once(child, "exit");
  try {
    const message = await Promise.race([once(child, "message"), exit.then(() => { throw new Error(errors); })]);
    assert.equal(message[0].boundary, boundary); child.kill("SIGKILL"); await exit;
    sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off", cdkBootstrap: false }); await sim.start();
    const domain = sim.opensearch.domain("eu-west-1", "migration-domain");
    for (let at = 0; at < 200 && domain.changes?.at(-1)?.state !== "COMPLETED"; at++) await delay(10);
    assert.equal(domain.state, "active"); assert.equal(domain.config.EncryptionAtRestOptions.Enabled, true); assert.equal(domain.changes?.at(-1)?.state, "COMPLETED");
    const engine = (sim.opensearch as any).engines.get(domain.generation);
    assert.equal((await engine.request("GET", "/products/_doc/ack", Buffer.alloc(0), "reader")).body._source.title, "migration-acknowledged-payload");
    assert.equal((await engine.request("POST", "/products/_count", Buffer.alloc(0), "reader")).body.count, 0);
    const directory = join(root, "data", "opensearch", domain.generation);
    assert.equal((await readdir(directory)).some(file => file.startsWith("search.sqlite")), false);
    const check = async (directory: string): Promise<void> => { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) await check(path); else assert.equal((await readFile(path)).includes(Buffer.from("migration-acknowledged-payload")), false); } };
    await check(directory);
    await sim.stop(); sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off", cdkBootstrap: false }); await sim.start();
    assert.equal(sim.opensearch.domain("eu-west-1", domain.name).revision, 2);
  } finally { child.kill(); await exit; await sim?.stop(); await rm(root, { recursive: true, force: true }); }
});

test("failed configuration publication preserves the working revision and permits a later update", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-os-config-failure-"));
  const sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off", cdkBootstrap: false });
  try {
    await sim.start(); await sim.opensearch.execute("CreateDomain", { DomainName: "revision-domain", EncryptionAtRestOptions: { Enabled: true } }, "eu-west-1");
    const domain = sim.opensearch.domain("eu-west-1", "revision-domain");
    while (domain.state !== "active") await delay(5);
    const save = sim.store.save.bind(sim.store); let fail = true;
    sim.store.save = async () => { if (fail && domain.changes?.at(-1)?.state === "COMPLETED") { fail = false; throw new Error("Simulated publication failure"); } await save(); };
    await sim.opensearch.execute("UpdateDomainConfig", { DomainName: domain.name, NodeToNodeEncryptionOptions: { Enabled: true } }, "eu-west-1");
    for (let at = 0; at < 100 && domain.changes?.at(-1)?.state !== "FAILED"; at++) await delay(10);
    assert.equal(domain.changes?.at(-1)?.state, "FAILED"); assert.equal(domain.state, "active"); assert.equal(domain.revision, 1); assert.equal(domain.config.NodeToNodeEncryptionOptions.Enabled, false);
    await sim.opensearch.execute("UpdateDomainConfig", { DomainName: domain.name, NodeToNodeEncryptionOptions: { Enabled: true } }, "eu-west-1");
    for (let at = 0; at < 100 && domain.changes?.at(-1)?.state !== "COMPLETED"; at++) await delay(10);
    assert.equal(domain.changes?.at(-1)?.state, "COMPLETED"); assert.equal(domain.revision, 2);
  } finally { await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
