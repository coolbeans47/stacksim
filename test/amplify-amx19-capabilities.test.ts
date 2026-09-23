import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { StackSim } from "../src/server.js";

const script = resolve("scripts/generate-amplify-auth-capabilities.mjs");
async function check(root?: string) {
  return new Promise<{ code: number | null; output: string }>((done, fail) => {
    const child = spawn(process.execPath, [script, "--check", ...(root ? ["--root", root] : [])], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", fail); child.once("close", code => done({ code, output }));
  });
}

test("AMX-19 capability generation is reproducible and rejects edited generated graph evidence", async () => {
  assert.deepEqual(await check(), { code: 0, output: "" });
  const root = await mkdtemp(join(tmpdir(), "stacksim-amx19-drift-"));
  try {
    await mkdir(join(root, "docs", "generated"), { recursive: true });
    await cp(resolve("docs/amplify-auth-capability-status.json"), join(root, "docs", "amplify-auth-capability-status.json"));
    await cp(resolve("docs/generated/amplify-auth-capabilities.json"), join(root, "docs", "generated", "amplify-auth-capabilities.json"));
    for (const path of ["docs/generated/amplify-auth-client-evidence.json", "examples/amplify-auth-notes/evidence/browser-smoke.json"]) {
      const content = await readFile(resolve(path)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
      if (content) {
        await mkdir(resolve(root, path, ".."), { recursive: true });
        await writeFile(resolve(root, path), content);
      }
    }
    for (const name of ["amplify-gen2-auth-email", "amplify-gen2-auth-data-owner", "amplify-gen2-auth-data-iam"]) {
      const source = resolve("test", "fixtures", name);
      const target = join(root, "test", "fixtures", name);
      await cp(source, target, { recursive: true, filter: path => !relative(source, path).split(/[\\/]/).some(part => ["node_modules", ".amplify", "amplify_outputs.json"].includes(part)) });
    }
    assert.equal((await check(root)).code, 0, "an independent evidence copy regenerates exactly");
    const path = join(root, "test", "fixtures", "amplify-gen2-auth-email", "evidence", "graph-manifest.json");
    const graph = JSON.parse(await readFile(path, "utf8"));
    graph.resources.find((resource: any) => resource.type === "AWS::Cognito::UserPool").properties.UnreviewedAuthProperty = true;
    await writeFile(path, `${JSON.stringify(graph, null, 2)}\n`);
    const drift = await check(root);
    assert.notEqual(drift.code, 0);
    assert.match(drift.output, /Unreviewed Amplify evidence drift:.*graph-manifest/);
    const checked = JSON.parse(await readFile(join(root, "docs", "generated", "amplify-auth-capabilities.json"), "utf8"));
    assert.equal(checked.fixtures[0].resources, 9, "check mode never rewrites the capability to accept drift");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("AMX-19 health reports the checked-in narrow capability and exact evidence hashes without secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-amx19-health-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off" });
  try {
    await simulator.start();
    const expected = JSON.parse(await readFile(resolve("docs/generated/amplify-auth-capabilities.json"), "utf8"));
    const health = await fetch(`http://127.0.0.1:${simulator.port}/_stacksim/health`).then(response => response.json()) as any;
    assert.deepEqual(health.compatibility.amplifyGen2Auth, expected);
    assert.equal(health.services.includes("amplify"), false, "Amplify remains a compatibility workflow over the existing services");
    assert.ok(["pending", "complete"].includes(expected.status));
    assert.equal(expected.fixtures.length, 3);
    for (const fixture of expected.fixtures) assert.match(fixture.evidenceSha256["graph-manifest.json"], /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(expected), /ASIA[0-9A-Z]{16}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]+\.eyJ|"(?:secretAccessKey|sessionToken|password)"\s*:/);
  } finally { await simulator.stop(); await rm(root, { recursive: true, force: true }); }
});
