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

for (const boundary of ["import-intent", "association-install", "partial-deletion"]) test(`dictionary packages recover acknowledged operations after forced termination at ${boundary}`, { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-package-crash-")), extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const child = fork(new URL(`./fixtures/opensearch-package-crash.${extension}`, import.meta.url), [root, boundary], { execArgv: extension === "ts" ? ["--import", "tsx"] : [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = ""; child.stderr?.on("data", data => { errors += data; }); const exited = once(child, "exit"); let sim: StackSim | undefined, search: Client | undefined;
  try {
    const [signal] = await Promise.race([once(child, "message"), exited.then(() => { throw new Error(`Package child exited: ${errors}`); }), delay(15000, undefined, { ref: false }).then(() => { throw new Error(`Timed out: ${errors}`); })]); assert.equal(signal.boundary, boundary); assert.ok(signal.id); child.kill("SIGKILL"); await exited;
    const region = "eu-west-1"; sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, authMode: "enforce", cdkBootstrap: false }); await sim.start();
    const result = await sim.opensearch.execute("DescribePackages", {}, region);
    if (boundary === "partial-deletion") { assert.deepEqual(result.PackageDetailsList, []); return; }
    assert.equal(result.PackageDetailsList[0].PackageID, signal.id); assert.equal(result.PackageDetailsList[0].PackageStatus, "AVAILABLE"); assert.equal(result.PackageDetailsList[0].AvailablePackageVersion, boundary === "import-intent" ? "1" : "2");
    const domain = sim.opensearch.domain(region, "package-recovery");
    if (boundary === "import-intent") { await sim.opensearch.execute("AssociatePackage", { PackageID: signal.id, DomainName: domain.name }, region); await (sim.opensearch as any).packages.drain(); }
    const associations = await sim.opensearch.execute("ListPackagesForDomain", { DomainName: domain.name }, region); assert.equal(associations.DomainPackageDetailsList[0].DomainPackageStatus, "ACTIVE"); assert.equal(associations.DomainPackageDetailsList[0].PackageVersion, boundary === "import-intent" ? "1" : "2");
    search = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath) }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => ({ accessKeyId: "admin", secretAccessKey: "password" }) }) });
    if (boundary === "import-intent") { await search.indices.create({ index: "products", body: { settings: { analysis: { analyzer: { words: { type: "custom", tokenizer: "standard", filter: ["dictionary"] } }, filter: { dictionary: { type: "synonym", synonyms_path: `analyzers/${signal.id}`, updateable: true } } } }, mappings: { properties: { title: { type: "text", search_analyzer: "words" } } } } }); await search.index({ index: "products", id: "one", body: { title: "apple" }, refresh: true }); }
    assert.equal((await search.search({ index: "products", body: { query: { match: { title: boundary === "import-intent" ? "fruit" : "pear" } } } })).body.hits.hits.length, 1);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } await search?.close(); await sim?.stop(); await rm(root, { recursive: true, force: true }); }
});
