import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EmbeddedSearchEngine } from "../src/opensearch/engine.js";

test("acknowledged writes, aliases and mappings survive forced process termination before refresh", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-os-crash-"));
  const file = join(root, "search.sqlite");
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const child = fork(new URL(`./fixtures/opensearch-crash-writer.${extension}`, import.meta.url), [file], { execArgv: extension === "ts" ? ["--import", "tsx"] : [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = ""; child.stderr?.on("data", chunk => errors += chunk);
  let engine: EmbeddedSearchEngine | undefined;
  try {
    const exit = once(child, "exit");
    const message = await Promise.race([once(child, "message"), exit.then(() => { throw new Error(`Writer exited before acknowledgement: ${errors}`); })]);
    assert.equal(message[0], "acknowledged");
    child.kill("SIGKILL"); await exit;
    engine = new EmbeddedSearchEngine(file);
    const document = (await engine.request("GET", "/surviving/_doc/acknowledged", Buffer.alloc(0), "reader")).body;
    assert.equal(document.found, true); assert.equal(document._version, 1);
    assert.equal(engine.indexes()[0].mappings.properties.title.type, "text");
    await engine.request("POST", "/durable/_refresh", Buffer.alloc(0), "reader");
    assert.equal((await engine.request("POST", "/surviving/_count", Buffer.from('{"query":{"match":{"title":"forced"}}}'), "reader")).body.count, 1);
  } finally { child.kill(); engine?.close(); await rm(root, { recursive: true, force: true }); }
});

for (const stage of ["create-intent", "activation-publish", "delete-intent", "delete-cleanup"]) {
  test(`OS-01 forced process termination at ${stage} reconciles exactly one resource generation`, { timeout: 30000 }, async () => {
    const { StackSim } = await import("../src/server.js");
    const root = await mkdtemp(join(tmpdir(), "stacksim-os-lifecycle-crash-"));
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const child = fork(new URL(`./fixtures/opensearch-lifecycle-crash.${extension}`, import.meta.url), [root, stage], { execArgv: extension === "ts" ? ["--import", "tsx"] : [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let errors = ""; child.stderr?.on("data", chunk => errors += chunk);
    let sim: InstanceType<typeof StackSim> | undefined;
    const exit = once(child, "exit");
    try {
      const message = await Promise.race([once(child, "message"), exit.then(() => { throw new Error(`Fixture exited before ${stage}: ${errors}`); })]);
      assert.equal(message[0].stage, stage); child.kill("SIGKILL"); await exit;
      sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off", cdkBootstrap: false });
      await sim.start();
      const domains = sim.opensearch.domains("eu-west-1");
      if (stage.startsWith("delete")) assert.equal(domains.length, 0);
      else { assert.equal(domains.length, 1); assert.equal(domains[0].state, "active"); assert.equal(domains[0].name, "crash-domain"); }
      await sim.stop(); sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off", cdkBootstrap: false }); await sim.start();
      assert.deepEqual(sim.opensearch.domains("eu-west-1").map(domain => [domain.name, domain.generation, domain.gatewayPort]), domains.map(domain => [domain.name, domain.generation, domain.gatewayPort]));
    } finally { child.kill(); await exit; await sim?.stop(); await rm(root, { recursive: true, force: true }); }
  });
}
