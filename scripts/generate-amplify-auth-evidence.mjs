import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Maintenance only: synthesize through the unchanged CLI and the network tripwire
// first. This recorder never modifies an assembly or generated template/asset.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureName = process.argv[2];
const tracePath = process.argv[3];
if (!/^amplify-gen2-auth-(email|data-owner|data-iam)$/.test(fixtureName ?? "") || !tracePath) {
  throw new Error("Usage: node scripts/generate-amplify-auth-evidence.mjs <fixture-name> <synthesis-trace.json>");
}
const fixture = join(root, "test", "fixtures", fixtureName);
const out = join(fixture, ".amplify", "artifacts", "cdk.out");
const evidence = join(fixture, "evidence");
const verifyRepeat = process.argv.includes("--verify-repeat");
const sha = content => createHash("sha256").update(content).digest("hex");
const json = async path => JSON.parse(await readFile(path, "utf8"));
const posix = path => path.replaceAll("\\", "/");
const writeJson = async (name, value) => writeFile(join(evidence, name), `${JSON.stringify(value, null, 2)}\n`);
async function filesUnder(path) {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(file));
    else files.push(file);
  }
  return files.sort();
}
function templateKind(document) {
  const types = Object.values(document.Resources ?? {}).map(resource => resource.Type);
  if (types.includes("AWS::Cognito::UserPool")) return "auth";
  if (types.includes("AWS::AppSync::GraphQLApi")) return "data";
  if (types.includes("Custom::AmplifyDynamoDBTable")) return "todo";
  if (types.includes("AWS::StepFunctions::StateMachine")) return "table-manager";
  return "root";
}
async function digestPath(path) {
  if (!(await stat(path)).isDirectory()) {
    const bytes = await readFile(path);
    return { sha256: sha(bytes), bytes: bytes.length, files: 1 };
  }
  const hash = createHash("sha256");
  let bytes = 0; let count = 0;
  for (const file of await filesUnder(path)) {
    const content = await readFile(file);
    hash.update(posix(relative(path, file))).update("\0").update(content).update("\0");
    bytes += content.length; count += 1;
  }
  return { sha256: hash.digest("hex"), bytes, files: count };
}

const trace = await json(resolve(tracePath));
if (trace.toolchain?.cliNodeVersion !== "22.13.0") throw new Error("Auth evidence requires the exact Node 22.13.0 CLI runtime");
if (!trace.calls.some(call => call.resultClass === "blocked:synthesis-only-no-workload-mutation")
  || trace.stateSummary.stacks !== 0 || trace.stateSummary.functions !== 0
  || trace.stateSummary.tables !== 0 || trace.stateSummary.appsyncApis !== 0) {
  throw new Error("Auth evidence requires a successful synthesis-only mutation tripwire");
}
let repeatSynthesis;
if (verifyRepeat) {
  const previous = await json(join(evidence, "graph-manifest.json"));
  const previousAssets = await json(join(evidence, "assets-manifest.json"));
  for (const template of previous.templates) {
    const current = await digestPath(join(out, template.sourceFile));
    if (current.sha256 !== template.sha256) throw new Error(`Repeat synthesis template drift: ${template.kind}`);
  }
  for (const asset of previousAssets.assets) {
    const current = await digestPath(join(out, asset.sourcePath));
    if (current.sha256 !== asset.sha256) throw new Error(`Repeat synthesis asset drift: ${asset.id}`);
  }
  repeatSynthesis = { nodeVersion: "22.13.0", unchangedTemplates: previous.templates.length, unchangedAssets: previousAssets.assets.length, exactBytesEqual: true, normalizationApplied: false };
}
await rm(evidence, { recursive: true, force: true });
await mkdir(join(evidence, "templates"), { recursive: true });
await mkdir(join(evidence, "assets"), { recursive: true });
const resources = []; const outputs = []; const templates = [];
const assembly = await json(join(out, "manifest.json"));
const assetArtifact = Object.values(assembly.artifacts ?? {}).find(artifact => artifact.type === "cdk:asset-manifest");
const assetManifestPath = assetArtifact?.properties.file;
const assetManifest = assetManifestPath ? await json(join(out, assetManifestPath)) : { files: {} };
const templateFiles = [...new Set([
  ...Object.values(assembly.artifacts ?? {}).filter(artifact => artifact.type === "aws:cloudformation:stack").map(artifact => artifact.properties.templateFile),
  ...Object.values(assetManifest.files ?? {}).map(asset => asset.source.path).filter(path => path.endsWith("template.json")),
])].sort();
for (const file of templateFiles) {
  const document = await json(join(out, file));
  const kind = templateKind(document);
  await copyFile(join(out, file), join(evidence, "templates", `${kind}.json`));
  templates.push({ kind, sourceFile: file, ...await digestPath(join(out, file)) });
  for (const [logicalId, resource] of Object.entries(document.Resources ?? {})) {
    resources.push({ template: kind, logicalId, type: resource.Type, properties: resource.Properties ?? {}, dependsOn: resource.DependsOn ?? [], deletionPolicy: resource.DeletionPolicy ?? null, updateReplacePolicy: resource.UpdateReplacePolicy ?? null });
  }
  for (const [name, definition] of Object.entries(document.Outputs ?? {})) outputs.push({ template: kind, name, definition });
}
await copyFile(join(out, "manifest.json"), join(evidence, "cloud-assembly.json"));
if (assetManifestPath) await copyFile(join(out, assetManifestPath), join(evidence, "asset-manifest.json"));
const assets = [];
for (const [id, asset] of Object.entries(assetManifest.files ?? {})) {
  const source = join(out, asset.source.path);
  assets.push({ id, displayName: asset.displayName, sourcePath: asset.source.path, packaging: asset.source.packaging, destinations: asset.destinations, ...await digestPath(source) });
  if ([".vtl", ".graphql"].includes(extname(source))) {
    await copyFile(source, join(evidence, "assets", `${id}${extname(source)}`));
  } else if ((await stat(source)).isDirectory()) {
    for (const file of await filesUnder(source)) {
      if (["model-schema.graphql", "modelIntrospectionSchema.json"].includes(file.split(/[\\/]/).at(-1))) {
        await copyFile(file, join(evidence, "assets", `${id}-${posix(relative(source, file)).replaceAll("/", "--")}`));
      }
    }
  }
}
assets.sort((a, b) => a.id.localeCompare(b.id));
const pkg = await json(join(fixture, "package.json"));
const lock = await json(join(fixture, "package-lock.json"));
await writeJson("dependency-manifest.json", {
  directDependencies: pkg.dependencies, directDevDependencies: pkg.devDependencies,
  lockfileVersion: lock.lockfileVersion,
  selectedPackages: Object.entries(lock.packages).map(([path, entry]) => ({ path: posix(path || "."), version: entry.version ?? null, resolved: entry.resolved ?? null, integrity: entry.integrity ?? null })),
});
const sourceFiles = [".node-version", "package.json", "package-lock.json", "tsconfig.json", ...await filesUnder(join(fixture, "amplify")).then(paths => paths.map(path => posix(relative(fixture, path))))];
await writeJson("fixture-source-manifest.json", { files: await Promise.all(sourceFiles.map(async path => ({ path, ...await digestPath(join(fixture, path)) }))) });
const iamEdges = resources.filter(resource => ["AWS::IAM::Policy", "AWS::IAM::Role"].includes(resource.type));
await writeJson("graph-manifest.json", { templates, resources, outputs, iamEdges,
  customResources: resources.filter(resource => resource.type.startsWith("Custom::")),
  cognito: resources.filter(resource => resource.type.startsWith("AWS::Cognito::")),
  appSyncAuthorization: resources.filter(resource => resource.type === "AWS::AppSync::GraphQLApi"),
});
await writeJson("assets-manifest.json", { directoryDigest: "sha256 of sorted relative path + NUL + raw file bytes + NUL", assets });
const calls = trace.calls.map(call => ({ ...call, path: call.path.replace(/([?&]uploadId=)[^&]*/g, "$1<upload-id>") }));
await writeJson("synthesis-only.json", {
  command: `node <Node 22.13.0> <unchanged ampx.js> sandbox --once --identifier amx13`,
  nodeVersion: "22.13.0", packageManager: pkg.packageManager,
  captureToolchain: trace.toolchain,
  fixture: fixtureName, result: { code: trace.result.code, signal: trace.result.signal },
  stateAfterRun: trace.stateSummary, workloadMutation: false,
  networkHostClasses: [...new Set(calls.map(call => call.hostClass))].sort(),
  firstBlockedMutation: calls.find(call => call.resultClass === "blocked:synthesis-only-no-workload-mutation"),
  originalArtifactsAreRewritten: false,
});
await writeJson("aws-call-trace.json", { commandPhase: "synthesis-only", amx02aActivated: calls.some(call => call.service === "amplify"), calls });
await writeJson("optional-network.json", { attempts: trace.optionalNetwork, isolation: trace.isolation });
await writeJson("auth-contract.json", {
  phase: "AMX-13A frozen generated contract; runtime/integration evidence is recorded separately",
  authorizationRule: fixtureName.endsWith("owner") ? "allow.owner()" : fixtureName.endsWith("iam") ? "allow.authenticated('identityPool')" : null,
  ...(fixtureName.endsWith("owner") ? { ownerFieldRule: "owner: a.string().authorization(allow => [allow.owner().to(['read','delete'])]); owner is stamped by unchanged generated authorization; explicit create/update owner input is denied, and owners can delete their records" } : {}),
  client: { package: "aws-amplify", version: pkg.dependencies["aws-amplify"], auth: ["signUp", "confirmSignUp", "signIn (USER_SRP_AUTH)", "fetchAuthSession (forceRefresh)", "signOut (local)"], data: fixtureName.endsWith("email") ? [] : ["Todo.create", "Todo.get", "Todo.list", "Todo.update", "Todo.delete", "Todo.onCreate", "Todo.onUpdate", "Todo.onDelete"] },
  expectedClientToken: { userPoolData: "access token (@aws-amplify/api-graphql graphqlAuth.mjs and realtime authHeaders.mjs)", identityPoolLogin: "ID token (Logins provider binding)" },
  guestCredentials: true, guestDataRule: false,
  generatedUserPoolPropertyClosure: ["UserAttributeUpdateSettings.AttributesRequireVerificationBeforeUpdate=['email']", "ExplicitAuthFlows includes ALLOW_CUSTOM_AUTH; CUSTOM_AUTH invocation remains fail-closed without its separately implemented trigger flow"],
  generatedIdentityPropertyClosure: ["SupportedLoginProviders={} is an empty provider set", "RoleMappings.UserPoolWebClientRoleMapping uses Token/AuthenticatedRole"],
  normalization: "No template/asset normalization: these three graphs contain no time-dependent API key.",
  outputs: "Root Metadata AWS::Amplify::Platform and nested output definitions are frozen verbatim; actual CLI-written outputs belong to AMX-14.",
  exclusions: ["social providers", "custom authentication challenge execution", "group rules", "Storage", "user Functions", "Hosting"],
});
const sources = [
  "@aws-amplify/core/dist/esm/singleton/Auth/types.d.ts",
  "@aws-amplify/api-graphql/dist/esm/internals/graphqlAuth.mjs",
  "@aws-amplify/api-graphql/dist/esm/Providers/AWSWebSocketProvider/authHeaders.mjs",
  "aws-amplify/node_modules/@aws-amplify/auth/dist/esm/providers/cognito/credentialsProvider/IdentityIdProvider.mjs",
  "aws-amplify/node_modules/@aws-amplify/auth/dist/esm/providers/cognito/credentialsProvider/credentialsProvider.mjs",
  "@aws-amplify/client-config/lib/client-config-contributor/client_config_contributor_v1.js",
  "@aws-amplify/client-config/lib/client-config-schema/client_config_v1.5.d.ts",
];
await writeJson("endpoint-derivation.json", {
  pinnedLibrary: "aws-amplify@6.20.0",
  userPool: { default: "derived regional public cognito-idp hostname", supportedOverride: "Auth.Cognito.userPoolEndpoint", route: "/_stacksim/cognito-idp/<region>/sdk", source: sources[0] },
  identityPool: { default: "derived regional public cognito-identity hostname", supportedOverride: "Auth.Cognito.identityPoolEndpoint", route: "/_stacksim/cognito-identity/<region>/sdk", source: sources[0] },
  appSyncHttp: { configuration: "CLI-written data.url", source: "official amplify_outputs.json" },
  appSyncRealtime: { configuration: "derived WSS peer of data.url with /realtime path", source: sources[2] },
  browserCors: { cognitoSdkPreflightHeaders: ["content-type", "x-amz-target", "x-amz-user-agent", "cache-control"], cacheControl: "no-store is emitted by the unmodified pinned browser Auth client; admitted only by scoped local SDK alias CORS" },
  configurationBoundary: "Configure from unmodified CLI-written outputs, then set the two public typed Cognito endpoint overrides in runtime Amplify configuration. AWS_ENDPOINT_URL does not configure these frontend clients.",
  observedNetworkProof: "AMX-13C/14 integration evidence; synthesis evidence does not claim frontend requests occurred",
  sourceProof: await Promise.all(sources.map(async path => ({ path, ...await digestPath(join(fixture, "node_modules", path)) }))),
});
await writeJson("output-contract.json", {
  version: "1.5", owner: "unmodified @aws-amplify/client-config output generator invoked by ampx",
  requiredTopLevel: ["version", "auth", ...(fixtureName.endsWith("email") ? [] : ["data"])],
  authFieldNames: ["aws_region", "user_pool_id", "user_pool_client_id", "identity_pool_id", "mfa_methods", "standard_required_attributes", "username_attributes", "user_verification_types", "groups", "mfa_configuration", "password_policy", "unauthenticated_identities_enabled"],
  authority: "CloudFormation Ref/GetAtt and root/nested Outputs; no synthetic resource IDs or rewritten output file",
  endpointFieldsEmittedByAuthSchema: [],
});
if (repeatSynthesis) await writeJson("repeat-synthesis.json", repeatSynthesis);
const entries = [];
for (const path of await filesUnder(evidence)) entries.push({ path: posix(relative(evidence, path)), ...await digestPath(path) });
await writeJson("evidence-manifest.json", { format: 1, phase: "AMX-13A", fixture: fixtureName, files: entries });
console.log(`${fixtureName}: froze ${resources.length} resources, ${assets.length} assets, ${outputs.length} outputs`);
