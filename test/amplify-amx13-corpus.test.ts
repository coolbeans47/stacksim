import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { canonicalTextBytes } from "./support/frozen-text.js";

const names = ["auth-email", "auth-data-owner", "auth-data-iam"];
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else files.push(path);
  }
  return files.sort();
}
for (const name of names) {
  const fixture = resolve(`test/fixtures/amplify-gen2-${name}`);
  const evidence = join(fixture, "evidence");
  test(`AMX-13A ${name} freezes the exact locked dependency graph, source, templates and assets`, async () => {
    const pkg = await json(join(fixture, "package.json"));
    const baseline = await json(resolve("test/fixtures/amplify-gen2-data/package.json"));
    assert.deepEqual(pkg.dependencies, baseline.dependencies);
    assert.deepEqual(pkg.devDependencies, baseline.devDependencies);
    assert.deepEqual(pkg.engines, { node: ">=22.13.0" });
    assert.equal((await readFile(join(fixture, ".node-version"), "utf8")).trim(), "22.13.0");
    const lock = await json(join(fixture, "package-lock.json"));
    const dependencies = await json(join(evidence, "dependency-manifest.json"));
    assert.equal(dependencies.selectedPackages.length, Object.keys(lock.packages).length);
    for (const selected of dependencies.selectedPackages) {
      const key = selected.path === "." ? "" : selected.path;
      const item = lock.packages[key] ?? lock.packages[key.replaceAll("/", "\\")];
      assert.ok(item, selected.path);
      assert.equal(selected.version, item.version ?? null);
      assert.equal(selected.integrity, item.integrity ?? null);
    }
    for (const [directory, manifest] of [[fixture, "fixture-source-manifest.json"], [evidence, "evidence-manifest.json"]]) {
      for (const entry of (await json(join(evidence, manifest))).files) {
        const bytes = canonicalTextBytes(await readFile(join(directory, entry.path)));
        assert.equal(sha(bytes), entry.sha256, `${name}/${entry.path} drift requires AMX-01 evidence review`);
        assert.equal(bytes.length, entry.bytes);
      }
    }
    const entries = (await json(join(evidence, "evidence-manifest.json"))).files;
    assert.deepEqual(entries.map((entry: any) => entry.path).sort(), (await filesUnder(evidence))
      .map(path => relative(evidence, path).replaceAll("\\", "/")).filter(path => path !== "evidence-manifest.json").sort());
  });
  test(`AMX-13A ${name} records unchanged graph, IAM, outputs and zero synthesis workload mutation`, async () => {
    const graph = await json(join(evidence, "graph-manifest.json"));
    assert.equal(graph.resources.length, name === "auth-email" ? 9 : name === "auth-data-owner" ? 84 : 83);
    assert.equal(graph.cognito.length, 4);
    const pool = graph.cognito.find((item: any) => item.type === "AWS::Cognito::UserPool");
    assert.deepEqual(pool.properties.UserAttributeUpdateSettings, { AttributesRequireVerificationBeforeUpdate: ["email"] });
    const identity = graph.cognito.find((item: any) => item.type === "AWS::Cognito::IdentityPool");
    assert.equal(identity.properties.AllowUnauthenticatedIdentities, true);
    assert.deepEqual(identity.properties.SupportedLoginProviders, {});
    const roles = graph.cognito.find((item: any) => item.type === "AWS::Cognito::IdentityPoolRoleAttachment").properties;
    assert.deepEqual(Object.keys(roles.Roles).sort(), ["authenticated", "unauthenticated"]);
    assert.equal(roles.RoleMappings.UserPoolWebClientRoleMapping.Type, "Token");
    assert.equal(roles.RoleMappings.UserPoolWebClientRoleMapping.AmbiguousRoleResolution, "AuthenticatedRole");
    if (name !== "auth-email") {
      assert.equal(graph.appSyncAuthorization[0].properties.AuthenticationType, "AMAZON_COGNITO_USER_POOLS");
      assert.deepEqual(graph.appSyncAuthorization[0].properties.AdditionalAuthenticationProviders, [{ AuthenticationType: "AWS_IAM" }]);
    }
    const synthesis = await json(join(evidence, "synthesis-only.json"));
    assert.equal(synthesis.nodeVersion, "22.13.0");
    assert.equal(synthesis.workloadMutation, false);
    assert.equal(synthesis.originalArtifactsAreRewritten, false);
    const repeat = await json(join(evidence, "repeat-synthesis.json"));
    assert.equal(repeat.exactBytesEqual, true);
    assert.equal(repeat.normalizationApplied, false);
    assert.equal(repeat.unchangedTemplates, name === "auth-email" ? 2 : 5);
    assert.deepEqual(synthesis.stateAfterRun, { stacks: 0, buckets: 1, functions: 0, tables: 0, appsyncApis: 0 });
    const trace = await json(join(evidence, "aws-call-trace.json"));
    assert.equal(trace.amx02aActivated, false);
    assert.ok(trace.calls.every((call: any) => call.hostClass === "approved-loopback"));
    const endpoints = await json(join(evidence, "endpoint-derivation.json"));
    assert.equal(endpoints.userPool.supportedOverride, "Auth.Cognito.userPoolEndpoint");
    assert.equal(endpoints.identityPool.supportedOverride, "Auth.Cognito.identityPoolEndpoint");
    assert.ok(endpoints.browserCors.cognitoSdkPreflightHeaders.includes("cache-control"));
    const all = (await Promise.all((await filesUnder(evidence)).map(path => readFile(path, "utf8")))).join("\n");
    assert.doesNotMatch(all, /AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|X-Amz-Security-Token|AWS_SECRET_ACCESS_KEY\s*[:=]|Authorization\s*:\s*Bearer/i);
  });
}

test("AMX-13A owner field is immutable through generated authorization and IAM remains a separate rule", async () => {
  const owner = resolve("test/fixtures/amplify-gen2-auth-data-owner/evidence");
  const assets = (await filesUnder(join(owner, "assets"))).filter(path => path.endsWith(".vtl"));
  const templates = await Promise.all(assets.map(path => readFile(path, "utf8")));
  assert.ok(templates.some(text => text.includes('$ownerAllowedFields0 = ["title","description","priority","completed","dueAt","id"]')));
  assert.ok(templates.some(text => text.includes('$ctx.args.input.put("owner", $ownerClaim0)')));
  assert.ok(templates.some(text => text.includes('$ctx.stash.put("authFilter"')));
  const contract = await json(resolve("test/fixtures/amplify-gen2-auth-data-iam/evidence/auth-contract.json"));
  assert.equal(contract.authorizationRule, "allow.authenticated('identityPool')");
  assert.equal(contract.guestDataRule, false);
});
