import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = args.indexOf("--root");
const root = option < 0 ? defaultRoot : resolve(args[option + 1]);
const output = resolve(root, "docs/generated/amplify-auth-capabilities.json");
const names = ["amplify-gen2-auth-email", "amplify-gen2-auth-data-owner", "amplify-gen2-auth-data-iam"];
const json = async path => JSON.parse(await readFile(resolve(root, path), "utf8"));
const textBytes = async path => Buffer.from((await readFile(resolve(root, path), "utf8")).replaceAll("\r\n", "\n"));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const fileDigest = async path => digest(await textBytes(path));
const runtimeEvidencePaths = [
  "docs/generated/amplify-auth-client-evidence.json",
  "examples/amplify-auth-notes/evidence/browser-smoke.json",
];
const manifestNames = ["fixture-source-manifest.json", "dependency-manifest.json", "graph-manifest.json", "assets-manifest.json", "aws-call-trace.json", "synthesis-only.json", "repeat-synthesis.json", "endpoint-derivation.json", "output-contract.json", "auth-contract.json", "evidence-manifest.json"];

async function verifyManifest(prefix, manifestPath) {
  const manifest = await json(manifestPath);
  for (const entry of manifest.files) {
    const path = `${prefix}/${entry.path}`;
    const bytes = await textBytes(path);
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) {
      throw new Error(`Unreviewed Amplify evidence drift: ${path}; regenerate and review the owning fixture evidence first`);
    }
  }
}

const status = await json("docs/amplify-auth-capability-status.json");
if (status.milestone !== "AMX-M4" || !["pending", "complete"].includes(status.status)
  || typeof status.qualification !== "string" || !status.qualification
  || status.completionRecord !== "docs/gap-3-authenticated-app-closeout.md") {
  throw new Error("Invalid Amplify capability closeout status; only reviewed pending/complete AMX-M4 records are accepted");
}
const fixtures = [];
for (const name of names) {
  const base = `test/fixtures/${name}`;
  const evidence = `${base}/evidence`;
  await verifyManifest(evidence, `${evidence}/evidence-manifest.json`);
  await verifyManifest(base, `${evidence}/fixture-source-manifest.json`);
  const pkg = await json(`${base}/package.json`);
  const lock = await json(`${base}/package-lock.json`);
  for (const [dependency, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unpinned Amplify dependency: ${dependency}`);
    const installed = lock.packages[`node_modules/${dependency}`] ?? lock.packages[`node_modules\\${dependency.replaceAll("/", "\\")}`];
    if (installed?.version !== version) throw new Error(`Amplify lock mismatch: ${dependency}`);
  }
  const graph = await json(`${evidence}/graph-manifest.json`);
  const synth = await json(`${evidence}/synthesis-only.json`);
  const repeat = await json(`${evidence}/repeat-synthesis.json`);
  if (synth.workloadMutation !== false || repeat.exactBytesEqual !== true) throw new Error(`Incomplete synthesis proof: ${name}`);
  const contract = await json(`${evidence}/auth-contract.json`);
  const transitiveVersions = {};
  for (const [path, metadata] of Object.entries(lock.packages)) {
    const dependency = path.replace(/^.*node_modules\//, "");
    if (!metadata.version || !(dependency === "constructs" || dependency === "aws-cdk-lib"
      || dependency.startsWith("@aws-sdk/client-") || dependency.startsWith("@aws-amplify/"))) continue;
    transitiveVersions[dependency] ??= [];
    if (!transitiveVersions[dependency].includes(metadata.version)) transitiveVersions[dependency].push(metadata.version);
  }
  fixtures.push({
    name, nodeVersion: synth.nodeVersion, packageManager: pkg.packageManager,
    dependencies: pkg.dependencies, devDependencies: pkg.devDependencies,
    transitiveVersions: Object.fromEntries(Object.entries(transitiveVersions).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([name, versions]) => [name, versions.sort()])),
    lockSha256: await fileDigest(`${base}/package-lock.json`),
    resources: graph.resources.length, templates: graph.templates.length,
    authorizationRule: contract.authorizationRule,
    ...(contract.ownerFieldRule ? { ownerFieldRule: contract.ownerFieldRule } : {}),
    evidenceSha256: Object.fromEntries(await Promise.all(manifestNames.map(async path => [path, await fileDigest(`${evidence}/${path}`)]))),
    synthesisPlatform: synth.captureToolchain,
  });
}
const runtimeEvidenceSha256 = {};
for (const path of runtimeEvidencePaths) {
  try { runtimeEvidenceSha256[path] = await fileDigest(path); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
const record = {
  schemaVersion: 1,
  generatedBy: "scripts/generate-amplify-auth-capabilities.mjs",
  capability: "amplify-gen2-authenticated-app",
  milestone: status.milestone,
  status: status.status,
  claim: status.status === "complete"
    ? "Pinned Amplify Gen 2 email Auth, User Pool owner Data and separate authenticated Identity Pool/IAM Data fixtures"
    : "Pinned Amplify Gen 2 Auth evidence and direct-resource authorization; complete frontend milestone pending",
  qualification: status.qualification,
  completionRecord: status.completionRecord,
  completionStatusSha256: await fileDigest("docs/amplify-auth-capability-status.json"),
  runtimeEvidenceSha256,
  fixtures,
  commands: {
    capabilityCheck: "node scripts/generate-amplify-auth-capabilities.mjs --check",
    focusedIntegration: "node --test dist/test/amplify-gen2-auth.test.js",
    frozenCorpus: "node --test dist/test/amplify-amx13-corpus.test.js dist/test/amplify-amx13-user-pool.test.js",
    deploy: "npm --prefix examples/amplify-auth-notes run deploy",
    start: "npm --prefix examples/amplify-auth-notes start",
    cleanup: "npm --prefix examples/amplify-auth-notes run backend:delete",
  },
  auth: {
    userPool: "Pinned Amplify SRP, confirmation, refresh and local sign-out; AppSync consumes verified access tokens",
    identityPool: "ID-token login into existing enhanced-flow Identity Pools and STS vault; same-session SigV4 Data",
    owner: "Unchanged generated VTL and DynamoDB conditions; immutable owner field and two-user CRUD/pagination/subscription isolation",
    guest: "Default guest credentials are retained; authenticated-only Data remains denied; issued authenticated credentials retain normal expiry",
    jwtRevocation: "Offline JWT verification does not treat local/global sign-out, disable or refresh revocation as automatic issued-JWT invalidation",
  },
  endpointOverrides: ["Auth.Cognito.userPoolEndpoint", "Auth.Cognito.identityPoolEndpoint"],
  runtime: { simulatorNode: ">=22.13.0", evidenceNode: "22.13.0", testedPlatforms: ["macOS arm64"], untestedPlatforms: ["Linux", "Windows"] },
  exclusions: ["unrestricted Amplify compatibility", "AMX-M3 general recovery programme", "Storage", "user Functions", "Hosting", "social identity providers", "custom-auth challenge execution", "advanced MFA/passwordless", "group-rule authorization", "arbitrary Identity Pool role mappings", "AppSync OIDC/Lambda authorization"],
  driftPolicy: "Package, source, template, asset, trace, output or endpoint drift requires regeneration and review of owning evidence before this capability can be regenerated; check mode never changes files",
};
const rendered = `${JSON.stringify(record, null, 2)}\n`;
if (args.includes("--check")) {
  const existing = await readFile(output, "utf8").catch(() => "");
  if (existing.replaceAll("\r\n", "\n") !== rendered) {
    console.error("Amplify Auth capability is stale. Run node scripts/generate-amplify-auth-capabilities.mjs after reviewing the owning evidence and closeout status.");
    process.exitCode = 1;
  }
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, rendered);
}
