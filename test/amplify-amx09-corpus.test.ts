import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { canonicalTextSha256 } from "./support/frozen-text.js";

const evidence = resolve("test/fixtures/amplify-gen2-data/evidence");

test("AMX-09 manifest freezes complete deployment/output behavior without changing protected AMX evidence", async () => {
  const manifest = JSON.parse(await readFile(resolve(evidence, "amx09-deployment-manifest.json"), "utf8"));
  assert.equal(manifest.phase, "AMX-09");
  assert.equal(manifest.deploymentGraph.totalResources, 75);
  assert.deepEqual(manifest.deploymentGraph.templates.map((template: any) => [template.kind, template.resources]), [["root", 2], ["data", 26], ["table-manager", 9], ["todo", 38]]);
  assert.equal(manifest.generatedNames.todoRoleNameLength, 49);
  assert.match(manifest.generatedNames.deferredNestedParameters, /authoritative resolved model is fully validated/);
  assert.match(manifest.generatedNames.iamBoundary, /\{1,64\}/);
  assert.deepEqual(manifest.outputs.file.dataKeys, ["api_key", "authorization_types", "aws_region", "default_authorization_type", "model_introspection", "url"]);
  assert.equal(manifest.outputs.file.version, "1.5");
  assert.match(manifest.endpoints.realtime, /appends \/realtime/);
  assert.deepEqual(manifest.clientProof.operations, ["create", "get", "list", "filter", "scoped pagination", "conditional error", "duplicate error", "update", "delete", "onCreate", "onUpdate", "onDelete"]);
  assert.ok(manifest.signals.forbidden.includes("GraphQL documents"));
  assert.ok(manifest.signals.forbidden.includes("output-file secrets"));
  for (const [file, expected] of Object.entries<string>(manifest.protectedEvidence)) {
    const actual = canonicalTextSha256(await readFile(resolve(evidence, file)));
    assert.equal(actual, expected, `${file} no longer matches the AMX-09 protected digest`);
  }
  for (const open of ["AMX-10 rerun/update/hotswap workflow behavior", "AMX-11 recovery hardening", "AMX-02A Amplify control plane", "AppSync Events"]) {
    assert.ok(manifest.negativeSurface.includes(open));
  }
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /da2-[A-Za-z0-9_-]{20,}|ASIA[0-9A-Z]{16}|secretAccessKey|sessionToken|PolicyDocument|mutation Conditional/i);
});
