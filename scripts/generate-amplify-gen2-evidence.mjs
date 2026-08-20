import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSchema, isInputObjectType } from "graphql";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "test", "fixtures", "amplify-gen2-data");
const out = join(fixture, ".amplify", "artifacts", "cdk.out");
const evidence = join(fixture, "evidence");
const writeMode = process.argv.includes("--write");
const traceArg = process.argv.indexOf("--trace");
const tracePath = traceArg >= 0 ? resolve(process.argv[traceArg + 1]) : join(evidence, "aws-call-trace.json");
const synthesisTraceArg = process.argv.indexOf("--synthesis-trace");
const synthesisTracePath = synthesisTraceArg >= 0 ? resolve(process.argv[synthesisTraceArg + 1]) : null;

// The protected templates/graph remain the historical CDK 2.263 compatibility
// corpus while dependency-only maintenance keeps the clean-install graph secure.
// A deliberate corpus migration must update this provenance atomically.
const frozenSynthesisProvenance = Object.freeze({
  status: "historical-compatibility-corpus",
  nodeVersion: "24.14.0",
  awsCdkLib: "2.263.0",
  bucketDeploymentAwsCliLayerAsset: "a72522445441e9b66c2f16956c54d4786af8c61c156b80c48a6e7c32fcc49023.zip",
  nodeVersionFile: Object.freeze({ sha256: "75daa0bc10dae1f22b2d13386b55b232adf16930d4325902f37b5033b3a7ca93", bytes: 8 }),
  packageJson: Object.freeze({ sha256: "67e02a0264f943e625933d80c634cd7794449bc9ae3d83697efcdcf175d0ca39", bytes: 388 }),
  packageLock: Object.freeze({ sha256: "ef8f447f4f0a68b19043356a733d9c76d39ee221351c997bb457124c09b59f18", bytes: 729922 }),
});

const json = async path => JSON.parse(await readFile(path, "utf8"));
const stableJson = value => `${JSON.stringify(value, null, 2)}\n`;
const sha = value => createHash("sha256").update(value).digest("hex");
const posix = value => value.replaceAll("\\", "/");
const canonicalText = value => Buffer.from(value.toString("utf8").replaceAll("\r\n", "\n"));

async function currentProjection() {
  const packageJson = await json(join(fixture, "package.json"));
  const lock = await json(join(fixture, "package-lock.json"));
  const fixtureSourceFiles = [".node-version", ".npmrc", "package.json", "package-lock.json", "tsconfig.json", "amplify/backend.ts", "amplify/data/resource.ts"];
  const fixtureSources = [];
  for (const path of fixtureSourceFiles) {
    const content = canonicalText(await readFile(join(fixture, path)));
    fixtureSources.push({ path, sha256: sha(content), bytes: content.length });
  }
  const dependencies = Object.entries(lock.packages).map(([path, item]) => ({
    path: posix(path || "."),
    name: item.name ?? (path ? path.split("node_modules/").at(-1) : packageJson.name),
    version: item.version ?? null,
    resolved: item.resolved ?? null,
    integrity: item.integrity ?? null,
    link: item.link === true,
  })).sort((a, b) => a.path.localeCompare(b.path));
  return {
    packageJson,
    lock,
    dependencyManifest: {
      scope: "current-clean-install",
      frozenSynthesisProvenance: "fixture-source-manifest.json",
      nodeRange: packageJson.engines.node,
      packageManager: packageJson.packageManager,
      lockfileVersion: lock.lockfileVersion,
      directDependencies: packageJson.dependencies,
      directDevDependencies: packageJson.devDependencies ?? {},
      selectedPackages: dependencies,
    },
    fixtureSourceManifest: { scope: "current-clean-install", frozenSynthesisProvenance, files: fixtureSources },
  };
}

async function verifyCurrentProjection(projection) {
  const expected = new Map([
    ["dependency-manifest.json", canonicalText(stableJson(projection.dependencyManifest))],
    ["fixture-source-manifest.json", canonicalText(stableJson(projection.fixtureSourceManifest))],
  ]);
  const drift = [];
  for (const [name, content] of expected) {
    const actual = canonicalText(await readFile(join(evidence, name)));
    if (sha(actual) !== sha(content)) drift.push(name);
  }
  const manifest = await json(join(evidence, "evidence-manifest.json"));
  for (const entry of manifest.files) {
    const content = canonicalText(await readFile(join(evidence, entry.path)));
    if (content.length !== entry.bytes || sha(content) !== entry.sha256) drift.push(`evidence-manifest:${entry.path}`);
  }
  if (drift.length) throw new Error(`AMX-01 current projection or protected evidence drift: ${[...new Set(drift)].sort().join(", ")}`);
}

function replaceStrings(value, replacements) {
  let text = JSON.stringify(value);
  for (const [from, to] of replacements) text = text.replaceAll(from, to);
  return JSON.parse(text);
}

async function filesUnder(path) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else files.push(full);
    }
  }
  await visit(path);
  return files.sort((a, b) => posix(relative(path, a)).localeCompare(posix(relative(path, b))));
}

async function digestPath(path) {
  const info = await stat(path);
  if (info.isFile()) {
    const bytes = await readFile(path);
    return { sha256: sha(bytes), bytes: bytes.length, files: 1 };
  }
  const hash = createHash("sha256");
  let bytes = 0;
  const entries = await filesUnder(path);
  for (const file of entries) {
    const content = await readFile(file);
    bytes += content.length;
    hash.update(posix(relative(path, file)));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return { sha256: hash.digest("hex"), bytes, files: entries.length };
}

function templateKind(template, file) {
  const types = new Set(Object.values(template.Resources ?? {}).map(resource => resource.Type));
  if (!file.includes("nested")) return "root";
  if (types.has("AWS::StepFunctions::StateMachine")) return "table-manager";
  if (types.has("Custom::AmplifyDynamoDBTable")) return "todo";
  return "data";
}

function collectIam(templateName, logicalId, resource) {
  const result = [];
  const documents = [];
  if (resource.Type === "AWS::IAM::Role") {
    documents.push({ kind: "trust", document: resource.Properties?.AssumeRolePolicyDocument });
    for (const policy of resource.Properties?.Policies ?? []) documents.push({ kind: "inline", name: policy.PolicyName, document: policy.PolicyDocument });
  }
  if (resource.Type === "AWS::IAM::Policy") documents.push({ kind: "attached", name: resource.Properties?.PolicyName, document: resource.Properties?.PolicyDocument });
  for (const item of documents) {
    for (const [index, statement] of (item.document?.Statement ?? []).entries()) {
      result.push({
        template: templateName,
        logicalId,
        policyKind: item.kind,
        policyName: item.name ?? null,
        statement: index,
        effect: statement.Effect,
        principals: statement.Principal ?? null,
        actions: Array.isArray(statement.Action) ? statement.Action : [statement.Action].filter(Boolean),
        resources: Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource].filter(Boolean),
        conditions: statement.Condition ?? null,
      });
    }
  }
  return result;
}

function endpointEvidence() {
  return {
    package: "aws-amplify@6.20.0",
    categories: {
      appSyncHttp: {
        derivation: "Amplify.configure output data.url becomes API.GraphQL.endpoint and is used verbatim for HTTP unless an operation endpoint or API.GraphQL.customEndpoint is supplied.",
        localOverride: "API.GraphQL.customEndpoint and customEndpointRegion are typed configuration fields; an operation endpoint also overrides it.",
        source: ["@aws-amplify/api-graphql/src/utils/resolveConfig.ts", "@aws-amplify/api-graphql/src/internals/InternalGraphQLAPI.ts"],
      },
      appSyncRealtime: {
        derivation: "For a standard AppSync data.url, replaces appsync-api with appsync-realtime-api and http/https with wss. A nonstandard/custom GraphQL URL appends /realtime and changes the scheme to wss.",
        localOverride: "No distinct realtime output or endpoint field. AMX-09 advertises the CA-backed HTTPS loopback GraphQL endpoint, so the pinned client derives the reachable WSS endpoint by appending /realtime without output rewriting.",
        source: ["@aws-amplify/api-graphql/src/Providers/AWSWebSocketProvider/appsyncUrl.ts"],
      },
      cognitoUserPool: {
        derivation: "Defaults to https://cognito-idp.<region>.<AWS DNS suffix>.",
        localOverride: "Auth.Cognito.userPoolEndpoint is a documented typed custom endpoint and is passed unchanged to the endpoint resolver.",
        source: ["aws-amplify nested @aws-amplify/auth/src/foundation/cognitoUserPoolEndpointResolver.ts", "@aws-amplify/core/src/singleton/Auth/types.ts"],
      },
      cognitoIdentity: {
        derivation: "Defaults to https://cognito-identity.<region>.<AWS DNS suffix>.",
        localOverride: "Auth.Cognito.identityPoolEndpoint is a documented typed custom endpoint and is passed unchanged to the endpoint resolver.",
        source: ["@aws-amplify/core/src/foundation/factories/serviceClients/cognitoIdentity/cognitoIdentityPoolEndpointResolver.ts", "@aws-amplify/core/src/singleton/Auth/types.ts"],
      },
      s3: {
        derivation: "Defaults to https://s3.<region>.<AWS DNS suffix>, then uses virtual-host bucket addressing unless force-path-style/internal conditions apply.",
        localOverride: "The pinned public Storage operation types do not expose customEndpoint. customEndpoint exists only on internal Storage APIs/config and rejects schemes except a package-private test sentinel, so no supported frontend loopback route is frozen.",
        source: ["@aws-amplify/storage/src/providers/s3/utils/client/s3data/base.ts", "@aws-amplify/storage/src/providers/s3/types/options.ts"],
      },
      lambda: {
        derivation: "aws-amplify has no direct Lambda invocation category. User functions are normally reached through an explicitly configured GraphQL or REST API endpoint.",
        localOverride: "No Lambda service endpoint override exists. API.REST.<name>.endpoint or API.GraphQL endpoint configuration controls the applicable HTTP frontend route.",
        source: ["@aws-amplify/api-rest/src/utils/resolveApiUrl.ts", "aws-amplify/package.json exports"],
      },
    },
  };
}

function outputSchema() {
  const authTypes = ["AMAZON_COGNITO_USER_POOLS", "API_KEY", "AWS_IAM", "AWS_LAMBDA", "OPENID_CONNECT"];
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "AMX-01 expected Amplify Data client output (secret values intentionally absent)",
    type: "object",
    additionalProperties: false,
    required: ["version", "data"],
    properties: {
      version: { const: "1.5" },
      data: {
        type: "object",
        additionalProperties: false,
        required: ["aws_region", "url", "default_authorization_type", "authorization_types"],
        properties: {
          aws_region: { type: "string" },
          url: { type: "string", format: "uri", description: "AppSync GraphQL HTTP endpoint" },
          model_introspection: { type: "object" },
          api_key: { type: "string", writeOnly: true, description: "Expected field name; no value is frozen in evidence" },
          default_authorization_type: { enum: authTypes },
          authorization_types: { type: "array", items: { enum: authTypes }, uniqueItems: true },
        },
      },
    },
  };
}

const resourceOwners = {
  "AWS::CloudFormation::Stack": ["AMX-03/AMX-09", "The exact four-template hierarchy is recursively admitted, stabilized, output-bound, restarted, and deleted through ordinary nested-stack execution"],
  "AWS::CDK::Metadata": ["AMX-03", "Metadata-only resource; no provider behavior required"],
  "AWS::S3::Bucket": ["AMX-04", "Exact two-bucket generated configuration and CORS behavior implemented"],
  "AWS::S3::BucketPolicy": ["AMX-04", "Exact generated auto-delete policy and cleanup mutation implemented"],
  "AWS::IAM::Role": ["AMX-04/AMX-05/AMX-09", "Generated AppSync roles are active; unresolved nested values defer only value-dependent preflight and the authoritative 49-character Todo role is fully IAM-validated"],
  "AWS::IAM::Policy": ["AMX-04", "Exact generated helper attachments and calls implemented"],
  "AWS::Lambda::Function": ["AMX-04", "Exact generated helper ZIP runtimes execute unchanged"],
  "AWS::Lambda::LayerVersion": ["AMX-04", "Exact generated AWS CLI layer digests implemented"],
  "AWS::StepFunctions::StateMachine": ["AMX-04", "Exact one-task Standard waiter implemented; no Parallel or Map"],
  "AWS::SSM::Parameter": ["AMX-04", "Exact four generated String resource_reference parameters implemented"],
  "AWS::AppSync::GraphQLApi": ["AMX-06/AMX-08/AMX-09", "Exact API_KEY/AWS_IAM configuration plus authoritative TLS GraphQLUrl and client-derived realtime URL back the generated output"],
  "AWS::AppSync::GraphQLSchema": ["AMX-06/AMX-08", "Generated @aws_api_key/@aws_iam/@aws_subscribe directives drive the frozen HTTP and realtime surface"],
  "AWS::AppSync::ApiKey": ["AMX-06/AMX-08", "Existing API-key lifecycle remains active and is rechecked for realtime registration and delivery"],
  "AWS::AppSync::DataSource": ["AMX-05/AMX-07", "NONE and generated DynamoDB descriptors execute the complete frozen Todo data path through the configured role and authoritative service"],
  "AWS::AppSync::FunctionConfiguration": ["AMX-05/AMX-07/AMX-08", "Exact 26-resource VTL function shape and ordering remain unchanged; CRUD and generated subscription registration pipelines execute their frozen corpus"],
  "AWS::AppSync::Resolver": ["AMX-05/AMX-07/AMX-08", "Exact eight-resource VTL PIPELINE shape remains unchanged; five Todo CRUD/list roots and three generated subscription roots are active"],
  "Custom::AmplifyDynamoDBTable": ["AMX-04/AMX-07", "Exact generated table-manager infrastructure helper and authoritative Todo resolver use are implemented"],
  "Custom::S3AutoDeleteObjects": ["AMX-04", "Exact generated helper protocol executes unchanged"],
  "Custom::CDKBucketDeployment": ["AMX-04", "Exact two generated bounded deployment calls implemented"],
};

function resourceInventory(graph) {
  const groups = new Map();
  for (const resource of graph.resources) {
    const group = groups.get(resource.type) ?? { count: 0, templates: new Set(), keys: new Set() };
    group.count += 1;
    group.templates.add(resource.template);
    Object.keys(resource.properties).forEach(key => group.keys.add(key));
    groups.set(resource.type, group);
  }
  const rows = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([type, group]) => {
    const [owner, disposition] = resourceOwners[type] ?? ["AMX-03", "Unexpected resource: fail the evidence gate and classify before implementation"];
    return `| \`${type}\` | ${group.count} | ${[...group.templates].sort().join(", ")} | ${[...group.keys].sort().map(key => `\`${key}\``).join(", ") || "—"} | \`${owner}\` | ${disposition} |`;
  });
  return `# Amplify Gen 2 resource inventory\n\nThis file is generated by \`scripts/generate-amplify-gen2-evidence.mjs\` from the pinned AMX-01 templates. Rows remain the narrow frozen fixture contract; broader Amplify behavior is not implied. Any row or property-key change must fail review until this inventory is deliberately regenerated.\n\n| Resource type | Count | Templates | Observed top-level properties | Owner | Current disposition |\n|---|---:|---|---|---|---|\n${rows.join("\n")}\n\nThe complete logical-resource graph remains frozen in \`test/fixtures/amplify-gen2-data/evidence/graph-manifest.json\`; AMX-04 through AMX-08 remain byte-protected by \`amx09-deployment-manifest.json\`. AMX-09 deploys this exact 75-resource graph to four truthful CREATE_COMPLETE stacks and generates directly usable output; AMX-10 workflow updates and all later surfaces remain open.\n`;
}

function actionInventory(trace) {
  const groups = new Map();
  for (const call of trace.calls) {
    const key = `${call.service}|${call.action}|${call.method}|${call.signingName}`;
    const group = groups.get(key) ?? { ...call, results: new Set(), roles: new Set(), paths: new Set() };
    group.results.add(call.resultClass);
    if (call.assumedRole) group.roles.add(call.assumedRole.split("/").at(-1));
    group.paths.add(call.path === "/" ? "/" : call.path.split("?")[0]);
    groups.set(key, group);
  }
  const owner = service => ({ ssm: "AMX-02", sts: "AMX-02", s3: "AMX-02/AMX-04", cloudformation: "AMX-02/AMX-03" }[service] ?? "AMX-01 drift review");
  const rows = [...groups.values()].sort((a, b) => `${a.service}:${a.action}`.localeCompare(`${b.service}:${b.action}`)).map(group =>
    `| \`${group.service}:${group.action}\` | \`${group.method}\` | \`${group.signingName}\` | ${[...group.roles].sort().map(value => `\`${value}\``).join(", ") || "base credentials"} | ${[...group.results].sort().map(value => `\`${value}\``).join(", ")} | \`${owner(group.service)}\` | Observed dependency; no new service action is implemented by AMX-01 |`);
  return `# Amplify Gen 2 action inventory\n\nThis file is generated by \`scripts/generate-amplify-gen2-evidence.mjs\` from the normalized unmodified \`ampx sandbox --once\` trace. The table stays the protected AMX-01 transport projection; AMX-09 additions are listed separately.\n\n| AWS action | Method | Signing name | Credential role(s) | Result classes | Owner | AMX-01 disposition |\n|---|---|---|---|---|---|---|\n${rows.join("\n")}\n\n## AMX-09 activated actions\n\n- Successful output generation adds signed \`cloudformation:GetTemplateSummary\` and \`s3:GetObject\` to the pinned CLI path.\n- Ordinary cleanup adds signed \`cloudformation:DeleteStack\` and stabilization \`DescribeStacks\` calls.\n- Provider execution admits \`appsync:ListFunctions\` through the reduced execution role's existing function-action family (\`appsync:*Function*\`); all remaining provider actions stay with their existing owners.\n- No \`amplify:*\` service call is emitted, so AMX-02A remains inactive.\n\n## Non-AWS network behavior\n\n- Amplify telemetry is disabled per process with \`AMPLIFY_DISABLE_TELEMETRY=1\`.\n- The notices/update read is redirected to an isolated loopback server; npm/CDK checks and EC2 metadata are disabled.\n- The CLI tripwire permits only its proxy/notices ports. The separate pinned-client proof trusts StackSim's durable loopback CA through \`NODE_EXTRA_CA_CERTS\` and connects only to the generated HTTPS/WSS loopback endpoint.\n- Evidence retains no API keys, credentials, signatures, headers, documents, variables, records, raw policies, or private contexts.\n`;
}

function amx05Manifest(graph, templates, assets) {
  const functions = graph.resources.filter(resource => resource.type === "AWS::AppSync::FunctionConfiguration");
  const resolvers = graph.resources.filter(resource => resource.type === "AWS::AppSync::Resolver");
  const api = graph.resources.find(resource => resource.type === "AWS::AppSync::GraphQLApi");
  return {
    format: 1,
    milestone: "AMX-05 exact generated VTL function and pipeline resolver surface",
    counts: { functionConfigurations: functions.length, pipelineResolvers: resolvers.filter(resource => resource.properties.Kind === "PIPELINE").length },
    functionConfigurations: functions.map(resource => ({ template: resource.template, logicalId: resource.logicalId, properties: resource.properties })),
    pipelineResolvers: resolvers.map(resource => ({ template: resource.template, logicalId: resource.logicalId, properties: resource.properties })),
    vtlAssets: assets.filter(asset => asset.sourcePath.endsWith(".vtl")).map(asset => ({ id: asset.id, sha256: asset.sha256, bytes: asset.bytes })).sort((a, b) => a.id.localeCompare(b.id)),
    negativeSurface: {
      functionRuntimeOrCode: functions.some(resource => resource.properties.Runtime !== undefined || resource.properties.Code !== undefined),
      resolverRuntimeOrCode: resolvers.some(resource => resource.properties.Runtime !== undefined || resource.properties.Code !== undefined),
      graphQlApiLogConfig: api?.properties.LogConfig !== undefined,
      appsyncJsActive: false,
    },
    signals: {
      namespace: "AWS/AppSync",
      metrics: ["GraphQLRequestCount", "ResolverRequestCount", "ResolverErrorCount", "ResolverLatency", "DataSourceLatency", "Latency", "4XXError", "5XXError"],
      graphqlApiLogConfig: "absent from the frozen graph; no field logs are emitted",
      templateLogs: "bounded request-local diagnostics only; never persisted as GraphQLApi.LogConfig output",
    },
  };
}

async function amx06Manifest(graph, assets) {
  const api = graph.resources.find(resource => resource.type === "AWS::AppSync::GraphQLApi");
  const schemaAsset = assets.find(asset => asset.sourcePath.endsWith(".graphql"));
  if (!api || !schemaAsset) throw new Error("AMX-06 requires the frozen GraphQL API and schema asset");
  const schema = await readFile(join(out, schemaAsset.sourcePath), "utf8");
  const rootFields = Object.fromEntries(["Query", "Mutation", "Subscription"].map(typeName => {
    const body = schema.match(new RegExp(`type\\s+${typeName}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
    const fields = [...body.matchAll(/^\s{2}([_A-Za-z][_0-9A-Za-z]*)\s*(?:\(|:)/gm)].map(match => match[1]);
    return [typeName, fields];
  }));
  return {
    format: 1,
    milestone: "AMX-06 generated AppSync AWS_IAM configuration and signed root-field authorization",
    graphqlApi: {
      logicalId: api.logicalId,
      authenticationType: api.properties.AuthenticationType,
      additionalAuthenticationProviders: api.properties.AdditionalAuthenticationProviders,
      rejectedAdditionalModes: ["AMAZON_COGNITO_USER_POOLS", "AWS_LAMBDA", "OPENID_CONNECT"],
    },
    schema: {
      asset: { id: schemaAsset.id, sha256: schemaAsset.sha256, bytes: schemaAsset.bytes },
      directives: {
        awsApiKey: (schema.match(/@aws_api_key\b/g) ?? []).length,
        awsIam: (schema.match(/@aws_iam\b/g) ?? []).length,
      },
      rootFields,
      subscriptions: "SDL admitted for the unchanged generated graph; HTTP/realtime subscription execution remains AMX-08",
    },
    iam: {
      action: "appsync:GraphQL",
      exactFieldArn: "arn:aws:appsync:${Region}:${Account}:apis/${GraphQLAPIId}/types/${TypeName}/fields/${FieldName}",
      typeWildcard: "arn:aws:appsync:${Region}:${Account}:apis/${GraphQLAPIId}/types/${TypeName}/*",
      apiWildcard: "arn:aws:appsync:${Region}:${Account}:apis/${GraphQLAPIId}/*",
      evaluator: "shared IAM identity/session-policy/permissions-boundary evaluator",
    },
    requestCorpus: [
      "official SigV4-compatible POST body, host, path, Region, service, timestamp, and temporary session credentials",
      "aliases, fragments, variables, multiple operations, explicit operation selection, and introspection",
      "exact field, root-type wildcard, API wildcard, implicit deny, explicit deny, and cross-account resource mismatch",
      "mixed nullable/non-null allowed and denied root fields with denied resolver suppression",
      "session policy, permission boundary, missing token, deleted/expired session, stale/future time, and tampering",
      "API-key/IAM identity and metric isolation plus credential/policy/header redaction",
    ],
    signals: {
      namespace: "AWS/AppSync",
      authenticationDimension: "AuthenticationType",
      authorizationDecisionFields: ["time", "requestId", "principalArn", "action", "resource", "decision", "reason"],
      cloudWatchFieldLogs: "absent because the frozen GraphQLApi has no LogConfig",
    },
  };
}

function s3TemplateAsset(value) {
  if (typeof value === "string") return value.match(/\/([0-9a-f]{64})\.vtl$/)?.[1];
  if (value && typeof value === "object" && value["Fn::Sub"] !== undefined) return s3TemplateAsset(value["Fn::Sub"]);
  return undefined;
}

async function amx07Manifest(graph, assets) {
  const schemaAsset = assets.find(asset => asset.sourcePath.endsWith(".graphql"));
  if (!schemaAsset) throw new Error("AMX-07 requires the frozen generated schema");
  const schemaText = await readFile(join(out, schemaAsset.sourcePath), "utf8");
  const schema = buildSchema(`${["AWSDate", "AWSTime", "AWSDateTime", "AWSTimestamp", "AWSEmail", "AWSJSON", "AWSURL", "AWSPhone", "AWSIPAddress"].map(name => `scalar ${name}`).join("\n")}
directive @aws_api_key on OBJECT | FIELD_DEFINITION
directive @aws_iam on OBJECT | FIELD_DEFINITION
directive @aws_subscribe(mutations: [String!]!) on FIELD_DEFINITION
${schemaText}`);
  const todoFields = Object.values(schema.getType("Todo").getFields()).map(field => ({ name: field.name, type: String(field.type) }));
  const rootFields = {};
  for (const typeName of ["Query", "Mutation"]) {
    rootFields[typeName] = Object.values(schema.getType(typeName).getFields())
      .filter(field => ["getTodo", "listTodos", "createTodo", "updateTodo", "deleteTodo"].includes(field.name))
      .map(field => ({ name: field.name, type: String(field.type), arguments: field.args.map(argument => ({ name: argument.name, type: String(argument.type) })) }));
  }
  const inputTypes = {};
  for (const typeName of [
    "CreateTodoInput", "UpdateTodoInput", "ModelTodoConditionInput", "ModelTodoFilterInput",
    "ModelStringInput", "ModelIDInput", "ModelIntInput", "ModelBooleanInput", "ModelSizeInput",
  ]) {
    const type = schema.getType(typeName);
    if (type && isInputObjectType(type)) inputTypes[typeName] = Object.values(type.getFields()).map(field => ({ name: field.name, type: String(field.type) }));
  }

  const functions = new Map(graph.resources.filter(resource => resource.type === "AWS::AppSync::FunctionConfiguration").map(resource => [resource.logicalId, resource]));
  const template = async (property, inline) => {
    const id = s3TemplateAsset(property);
    if (!id) return { kind: "inline", sha256: sha(inline), bytes: Buffer.byteLength(inline) };
    const asset = assets.find(candidate => candidate.id === id);
    if (!asset) throw new Error(`AMX-07 template asset ${id} is missing`);
    return { kind: "asset", id, sha256: asset.sha256, bytes: asset.bytes };
  };
  const pipelines = [];
  const utilitySet = new Set();
  const documents = [];
  for (const resolver of graph.resources.filter(resource => resource.type === "AWS::AppSync::Resolver"
    && ["getTodo", "listTodos", "createTodo", "updateTodo", "deleteTodo"].includes(resource.properties.FieldName))) {
    const ordered = [];
    for (const reference of resolver.properties.PipelineConfig.Functions) {
      const logicalId = reference["Fn::GetAtt"][0];
      const fn = functions.get(logicalId);
      const requestId = s3TemplateAsset(fn.properties.RequestMappingTemplateS3Location);
      const responseId = s3TemplateAsset(fn.properties.ResponseMappingTemplateS3Location);
      const requestText = requestId ? await readFile(join(out, assets.find(asset => asset.id === requestId).sourcePath), "utf8") : fn.properties.RequestMappingTemplate;
      const responseText = responseId ? await readFile(join(out, assets.find(asset => asset.id === responseId).sourcePath), "utf8") : fn.properties.ResponseMappingTemplate;
      for (const text of [requestText, responseText]) for (const match of text.matchAll(/\$util\.([A-Za-z0-9_.]+)/g)) utilitySet.add(match[1]);
      const literalOperation = requestText.match(/"operation"\s*:\s*"(GetItem|PutItem|UpdateItem|DeleteItem|Query|Scan)"/)?.[1] ?? null;
      const operation = fn.properties.Name === "QueryListTodosDataResolverFn" ? "Scan" : literalOperation;
      if (operation) documents.push({
        rootField: resolver.properties.FieldName, functionName: fn.properties.Name, operation,
        ...(fn.properties.Name === "QueryListTodosDataResolverFn" ? { operationForm: "$operation resolves to Scan for the frozen no-index Todo list branch; query/index branches remain unsupported" } : {}),
        requestAsset: requestId, responseAsset: responseId,
      });
      ordered.push({
        logicalId, name: fn.properties.Name, dataSource: fn.properties.DataSourceName,
        request: await template(fn.properties.RequestMappingTemplateS3Location, fn.properties.RequestMappingTemplate),
        response: await template(fn.properties.ResponseMappingTemplateS3Location, fn.properties.ResponseMappingTemplate),
        operation,
      });
    }
    pipelines.push({
      typeName: resolver.properties.TypeName, fieldName: resolver.properties.FieldName,
      before: await template(undefined, JSON.stringify(resolver.properties.RequestMappingTemplate)),
      after: await template(undefined, resolver.properties.ResponseMappingTemplate),
      functions: ordered,
    });
  }
  pipelines.sort((a, b) => `${a.typeName}.${a.fieldName}`.localeCompare(`${b.typeName}.${b.fieldName}`));
  documents.sort((a, b) => `${a.rootField}.${a.functionName}`.localeCompare(`${b.rootField}.${b.functionName}`));

  return {
    format: 1,
    milestone: "AMX-07 frozen generated one-model Amplify Data semantics",
    schema: { asset: { id: schemaAsset.id, sha256: schemaAsset.sha256, bytes: schemaAsset.bytes }, todoFields, rootFields, inputTypes },
    pipelines,
    dynamodbDocuments: documents,
    expressionCorpus: {
      comparison: ["eq", "ne", "lt", "le", "gt", "ge"],
      stringAndId: ["contains", "notContains", "between", "beginsWith", "attributeExists", "attributeType", "size"],
      number: ["between", "attributeExists", "attributeType"],
      boolean: ["attributeExists", "attributeType"],
      recursive: ["and", "or", "not"],
      updateActions: ["SET non-null input/default fields", "REMOVE explicitly null non-key fields"],
      keyConditions: ["create id attribute_not_exists", "update/delete id attribute_exists"],
    },
    utilities: [...utilitySet].sort(),
    defaultsAndRecords: {
      id: "$util.autoId() UUID when create input omits id; explicit input id wins",
      createdAt: "$util.time.nowISO8601() once during create init",
      updatedAt: "same create instant, then $util.time.nowISO8601() during every update init",
      typename: "Todo persisted as __typename",
      nullAndAbsent: "omitted update fields are preserved; explicit nullable fields emit REMOVE; createdAt is never rewritten by update",
      list: "Scan with emitted default limit 100, DynamoDB filter-after-limit ordering, empty intermediate pages allowed",
    },
    pagination: {
      opaqueSigned: true,
      encoding: "versioned AES-256-GCM authenticated encryption derived from the installation pagination secret; traversal state is not inspectable",
      ttlMilliseconds: 3_600_000,
      scopes: ["account", "Region", "API id/generation", "schema generation", "root type/field", "function generation/revision", "data-source generation/revision", "table replacement id", "index", "authorization mode", "authorization identity digest", "filter/expression document", "limit", "traversal key"],
      rejects: ["malformed", "expired", "cross-API", "cross-field", "cross-filter", "cross-limit", "cross-account", "cross-Region", "cross-auth-mode/identity", "stale function/schema/data-source/table generation"],
    },
    failureContract: {
      request: "template/document failures occur before authoritative DynamoDB access and do not run the data response template",
      setup: "missing table, role assumption, identity/resource policy denial run generated pipeline response VTL with result null and safe message/type",
      invoked: "DynamoDB conditional/validation/service failures run generated pipeline response VTL with result null and safe message/type",
      response: "get/list responses preserve modeled DynamoDB errors; mutation response VTL touches null result before its error branch and therefore raises MappingTemplate for those emitted error paths",
      completion: "GraphQL applies standard nullable/non-null propagation and partial-data paths after response VTL",
      committedWrites: "never rolled back or automatically reinvoked after response VTL, serialization, or GraphQL completion failure",
      dug08: "equivalent behavior implemented for shared generated PIPELINE functions; the owning UNIT resolver path remains open",
    },
    authorization: {
      admission: ["API_KEY @aws_api_key", "AWS_IAM @aws_iam plus appsync:GraphQL field ARN"],
      executionRoleActions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"],
      order: "schema/field admission before resolver; data-source role and resource policy before item operation",
    },
    client: { package: "aws-amplify@6.20.0", methods: ["create", "get", "list", "update", "delete"], model: "Todo", generatedDocumentsOutsideFixture: false },
    negativeSurface: ["relationships", "secondary indexes", "custom identifiers", "conflict sync", "custom operations", "search", "SQL", "generated documents outside the frozen client/model-introspection corpus", "HTTP/realtime subscriptions (AMX-08)", "complete deployment/output generation and overlength generated RoleName (AMX-09)"],
    signals: {
      namespace: "AWS/AppSync",
      metrics: ["GraphQLRequestCount", "GraphQLErrorCount", "ResolverRequestCount", "ResolverErrorCount", "ResolverLatency", "DataSourceLatency", "Latency", "4XXError", "5XXError"],
      dimensions: ["GraphQLAPIId", "TypeName", "FieldName", "DataSource", "AuthenticationType"],
      logs: "GraphQLApi.LogConfig absent; VTL diagnostics remain request-local and are not persisted",
      redacted: ["variables", "record payloads", "credentials", "session tokens", "signatures", "authorization/x-api-key headers", "raw policies", "private resolver/DynamoDB context"],
    },
  };
}

async function amx08Manifest(graph, assets, protectedEvidence) {
  const schemaAsset = assets.find(asset => asset.sourcePath.endsWith(".graphql"));
  if (!schemaAsset) throw new Error("AMX-08 requires the frozen generated schema");
  const schemaText = await readFile(join(out, schemaAsset.sourcePath), "utf8");
  const schema = buildSchema(`${["AWSDate", "AWSTime", "AWSDateTime", "AWSTimestamp", "AWSEmail", "AWSJSON", "AWSURL", "AWSPhone", "AWSIPAddress"].map(name => `scalar ${name}`).join("\n")}
directive @aws_api_key on OBJECT | FIELD_DEFINITION
directive @aws_iam on OBJECT | FIELD_DEFINITION
directive @aws_subscribe(mutations: [String!]!) on FIELD_DEFINITION
${schemaText}`);
  const subscriptionType = schema.getSubscriptionType();
  if (!subscriptionType) throw new Error("AMX-08 requires the generated Subscription type");
  const subscriptionFields = Object.values(subscriptionType.getFields()).map(field => {
    const directive = field.astNode?.directives?.find(value => value.name.value === "aws_subscribe");
    const links = directive?.arguments?.find(value => value.name.value === "mutations")?.value;
    return {
      name: field.name,
      type: String(field.type),
      arguments: field.args.map(argument => ({ name: argument.name, type: String(argument.type) })),
      mutationLinks: links?.kind === "ListValue" ? links.values.map(value => value.value) : [],
      authorizationDirectives: field.astNode?.directives?.map(value => value.name.value).filter(value => value === "aws_api_key" || value === "aws_iam").sort() ?? [],
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const inputTypes = {};
  for (const typeName of [
    "ModelSubscriptionTodoFilterInput", "ModelSubscriptionStringInput", "ModelSubscriptionIDInput",
    "ModelSubscriptionIntInput", "ModelSubscriptionBooleanInput",
  ]) {
    const type = schema.getType(typeName);
    if (type && isInputObjectType(type)) inputTypes[typeName] = Object.values(type.getFields()).map(field => ({ name: field.name, type: String(field.type) }));
  }
  const functions = new Map(graph.resources.filter(resource => resource.type === "AWS::AppSync::FunctionConfiguration").map(resource => [resource.logicalId, resource]));
  const pipelineDependencies = graph.resources.filter(resource => resource.type === "AWS::AppSync::Resolver" && resource.properties.TypeName === "Subscription")
    .map(resolver => ({
      typeName: resolver.properties.TypeName,
      fieldName: resolver.properties.FieldName,
      functions: resolver.properties.PipelineConfig.Functions.map(reference => {
        const fn = functions.get(reference["Fn::GetAtt"][0]);
        return {
          logicalId: reference["Fn::GetAtt"][0], name: fn.properties.Name, dataSource: fn.properties.DataSourceName,
          requestAsset: s3TemplateAsset(fn.properties.RequestMappingTemplateS3Location),
          responseAsset: s3TemplateAsset(fn.properties.ResponseMappingTemplateS3Location),
        };
      }),
    })).sort((a, b) => a.fieldName.localeCompare(b.fieldName));
  return {
    format: 1,
    milestone: "AMX-08 frozen generated Todo AppSync realtime subscription surface",
    protectedEvidence,
    schema: {
      asset: { id: schemaAsset.id, sha256: schemaAsset.sha256, bytes: schemaAsset.bytes },
      subscriptionFields,
      inputTypes,
      selection: {
        aliases: true, fragments: true, variables: true, multipleOperationsRequireOperationName: true,
        defaultGeneratedTodoFields: ["title", "description", "priority", "completed", "dueAt", "id", "createdAt", "updatedAt", "__typename"],
        mutationSelectionDependency: "event source is the successfully completed linked mutation field result after its mutation selection; absent nullable fields complete as null and absent non-null fields produce GraphQL error paths/null propagation",
      },
    },
    pipelines: pipelineDependencies,
    endpoint: {
      descriptor: "GraphQLApi.uris.REALTIME and AWS::AppSync::GraphQLApi GetAtt RealtimeUrl",
      shape: "ws(s)://<GraphQL host>/graphql/${Region}/${GraphQLAPIId}/realtime",
      currentClient: "aws-amplify@6.20.0",
      localClientConfiguration: "AMX-08 configures the generated subscription client with the descriptor's ws GraphQL base so its unchanged custom-domain derivation appends /realtime; AMX-09 output generation remains open",
      encodings: ["graphql-ws plus header-<base64url(JSON authorization headers)> subprotocol", "header=<base64/base64url JSON>&payload=<base64/base64url {}> query encoding"],
      selectedSubprotocol: "graphql-ws (AppSync message semantics, not generic graphql-ws)",
    },
    protocol: {
      clientMessages: ["connection_init", "start", "stop"],
      serverMessages: ["connection_ack", "connection_error", "start_ack", "data", "ka", "complete", "error"],
      connectionAck: { connectionTimeoutMs: 300000 },
      closeSignals: { protocol: 4400, authorization: 4401, initializationTimeout: 4408, repeatedInitialization: 4429, connectionQueue: 1013, generationOrShutdown: 1012, idleOrLifetime: 1001 },
      registrationError: "id-scoped error; unrelated registrations survive",
      stop: "id-scoped complete followed by no further delivery",
    },
    authorization: {
      modes: ["API_KEY", "AWS_IAM"],
      connectionBinding: ["API generation", "authorization mode", "API-key id or IAM principal/access-key identity digest"],
      registrationRecheck: "per-start authorization is independently verified and must match the connection identity",
      deliveryRecheck: "API key existence/expiry, IAM identity/session existence, schema directive, and live appsync:GraphQL field policy",
      rejected: ["wrong/expired/deleted key", "missing/tampered/stale signature", "implicit deny", "explicit deny", "cross-account", "cross-Region", "cross-API", "cross-mode", "cross-key", "cross-principal"],
    },
    delivery: {
      trigger: "successful linked AppSync mutation resolver, response functions, GraphQL field completion, and bounded response serialization only",
      excludedTriggers: ["DynamoDB direct writes", "DynamoDB Streams", "replay", "restart recovery"],
      isolation: "authorization, filtering, selection completion, queueing, and socket send are evaluated per registration and never fail the mutation or another healthy registration",
      commitBoundary: "socket loss after mutation completion may lose the live event; the mutation is never rolled back, retried, or synthesized",
    },
    limits: {
      connectionsPerRegion: 100, connectionsPerApi: 50, registrationsPerConnection: 100, registrationsPerApi: 1000,
      incomingMessageBytes: 262144, outgoingMessageBytes: 1048576, authorizationHeaderBytes: 16384,
      queryBytes: 262144, variablesBytes: 262144, documentDepth: 75, documentFields: 1000,
      registrationQueueMessages: 16, registrationQueueBytes: 1048576, connectionQueueMessages: 64, connectionQueueBytes: 4194304,
      fanoutPerMutation: 1000, initializationMs: 15000, keepAliveMs: 60000, idleMs: 300000, lifetimeMs: 7200000,
      overflow: "registration queue/message overflow sends safe id-scoped error+complete and drops that registration; connection queue overflow closes only that connection with 1013",
    },
    lifecycle: {
      generations: ["API", "schema", "authorization configuration", "resolver/function/data-source configuration"],
      updateBehavior: "close sockets for the affected API on API/schema/auth-configuration/resolver generation changes, but only sockets bound to an updated/deleted API key on key lifecycle changes; use 1012 and require reconnect/re-registration; mutation snapshots cannot cross-deliver into another generation",
      identityInvalidation: "key deletion/expiry or IAM identity invalidation prevents delivery; key lifecycle closure is isolated by key id and field-policy denial errors/completes only that registration",
      persistence: "only API/schema/resolver/subscription configuration is durable; connections, registrations, timers, queues, and pending messages are process-local with no replay/outbox",
    },
    signals: {
      namespace: "AWS/AppSync",
      metrics: [
        "RealtimeConnectionAdmission", "RealtimeConnectionClose", "RealtimeSubscriptionRegistrationAdmission",
        "RealtimeSubscriptionRegistrationRejected", "RealtimeSubscriptionStop", "RealtimeMutationCompletion",
        "RealtimeSubscriptionAuthorizationAdmission", "RealtimeSubscriptionFilterAdmission", "RealtimeSubscriptionFilterRejection",
        "RealtimeSubscriptionQueueDrop", "RealtimeSocketDelivery", "RealtimeSocketDeliveryFailure",
      ],
      dimensions: ["GraphQLAPIId", "AuthenticationType", "Reason"],
      privateDiagnostics: "256 process-local safe summaries; server connection ids and hashed client registration ids only",
      cloudWatchLogs: "none: the frozen GraphQLApi has no LogConfig",
      crashSemantics: {
        connectionAndRegistration: "may be absent or duplicated around process failure; state is non-durable",
        mutationCompletion: "metric/diagnostic may be lost; no event outbox is implied",
        authorizationFilterQueueDelivery: "may be lost or duplicated as telemetry around a crash; application event is at-most-live-delivery with no replay",
      },
      redacted: ["GraphQL documents", "variables", "application payloads", "API keys", "authorization headers", "SigV4 material", "session tokens", "credentials", "raw policies", "private resolver context"],
    },
    failureInjection: ["registration-admission", "mutation-completion", "queueing", "socket-send"],
    client: { package: "aws-amplify@6.20.0", methods: ["onCreate", "onUpdate", "onDelete"], model: "Todo", sourceGeneratedAtRuntimeFromPinnedModelIntrospection: true },
    negativeSurface: ["Cognito", "Lambda authorization", "OIDC", "enhanced subscription filters", "subscription invalidation", "AppSync Events", "generic graphql-ws", "MQTT", "DynamoDB Streams fan-out", "AMX-09 deployment/output generation"],
  };
}

function amx09Manifest(protectedEvidence) {
  return {
    format: 1,
    phase: "AMX-09",
    contract: "first complete unmodified frozen Amplify Gen 2 sandbox deployment and directly usable generated output",
    protectedEvidence,
    pinnedExecution: {
      command: "node node_modules/@aws-amplify/backend-cli/lib/ampx.js sandbox --once --identifier amx01",
      workingDirectory: "test/fixtures/amplify-gen2-data",
      cliOwns: ["synthesis", "bootstrap lookup", "asset publication", "CloudFormation deployment", "stabilization", "output generation", "amplify_outputs.json write"],
      forbidden: ["template rewriting", "fixture installer", "private state mutation", "parallel Amplify engine", "shadow output generator", "output post-processing", "client patching"],
    },
    deploymentGraph: {
      completeGraphReference: "graph-manifest.json plus dependency-manifest.json; both remain the AMX-01 authoritative 75-resource/dependency corpus",
      templates: [
        { kind: "root", resources: 2, owner: "CloudFormation recursive executor" },
        { kind: "data", resources: 26, owner: "CloudFormation nested stack data7552DF31" },
        { kind: "table-manager", resources: 9, owner: "CloudFormation nested AmplifyTableManager stack" },
        { kind: "todo", resources: 38, owner: "CloudFormation nested Todo stack" },
      ],
      totalResources: 75,
      terminalStatus: "CREATE_COMPLETE for root, Data, Table Manager, and Todo",
      orderingRule: "CloudFormation dependency graph order; each production provider stabilizes before dependents; nested outputs bind only after child terminal success",
      ownership: "Every physical resource remains in its owning service and records stack/root/parent logical ownership",
      providers: {
        CloudFormation: ["root stack", "three recursive nested stacks", "events", "outputs", "rollback", "delete"],
        AppSync: ["GraphQLApi", "GraphQLSchema", "ApiKey", "DataSource", "26 FunctionConfiguration resources", "8 PIPELINE resolvers"],
        IAM_STS: ["roles", "inline/managed policy attachment", "PassRole", "service sessions"],
        S3: ["versioned assets", "model schema", "BucketDeployment", "auto-delete helper"],
        Lambda: ["generated provider/helper functions", "layers", "ordinary invocation and tag ownership"],
        DynamoDB: ["Todo table", "stream", "CRUD/filter/pagination storage"],
        StepFunctions: ["table-manager waiter"],
        SSM: ["GraphQL API ID parameter", "bootstrap version parameter"],
      },
    },
    generatedNames: {
      deferredNestedParameters: "Opaque discovery markers are tainted non-service values. Provider semantic validation/canonicalization/planning is deferred only for a resource model containing one; the authoritative resolved model is fully validated at ordinary create/update execution.",
      todoRoleNameExpression: "TodoIAMRolecfd440- + authoritative 26-hex AppSync API ID + -NONE",
      todoRoleNameLength: 49,
      iamBoundary: "Explicit RoleName remains /^[A-Za-z0-9_+=,.@-]{1,64}$/; invalid literal create/update/replacement requests fail and are never truncated, ignored, or admitted.",
      lifecycle: "The resolved role name is the stable physical ID for create/read/update/restart/delete/collision/rollback; a RoleName change is normal replacement.",
      lambdaGeneratedName: "If stack-logical-suffix exceeds 64 characters, preserve up to 20 sanitized stack characters, then as much sanitized logical ID as fits, then the stable 10-hex suffix. This keeps generated IAM wildcard ownership usable without changing explicit FunctionName.",
    },
    bootstrap: {
      compatibilityVersion: 23,
      policyRevision: 15,
      addedOwningPermission: "appsync:*Function* admits appsync:ListFunctions for AWS::AppSync::FunctionConfiguration create stabilization",
      deletionBoundary: "Workload deletion preserves the bootstrap bucket, roles, policies, and /cdk-bootstrap/hnb659fds/version parameter",
    },
    outputs: {
      retrieval: "GetTemplateSummary(StackName).Metadata JSON string plus DescribeStacks authoritative outputs",
      rootKeys: ["deploymentType", "region", "awsAppsyncApiId", "awsAppsyncApiEndpoint", "awsAppsyncAuthenticationType", "awsAppsyncRegion", "amplifyApiModelSchemaS3Uri", "awsAppsyncApiKey", "awsAppsyncAdditionalAuthenticationTypes"],
      dataContributors: ["GraphQLApi.ApiId", "GraphQLApi.GraphQLUrl", "ApiKey.ApiKey", "BucketDeployment.DestinationBucketArn"],
      file: {
        path: "amplify_outputs.json",
        writer: "pinned backend-cli output lifecycle handler",
        atomicity: "Pinned writer uses its observed ordinary writeFile path; AMX-09 does not claim an atomic rename guarantee",
        topLevelKeys: ["data", "version"],
        dataKeys: ["api_key", "authorization_types", "aws_region", "default_authorization_type", "model_introspection", "url"],
        version: "1.5",
        digestRule: "Evidence records sha256 over canonical generated output after replacing data.api_key with <redacted>; no digest of the secret-bearing raw file is retained",
        failureRule: "The harness removes a prior generated artifact before invocation; no client run is admitted unless the CLI reports File written after terminal deployment success",
      },
    },
    endpoints: {
      graphql: "Generated data.url is the authoritative HTTPS loopback GraphQLUrl and is used verbatim by Amplify 6.20",
      realtime: "Pinned client derives wss:// from https:// and appends /realtime for the custom loopback URL; the same durable loopback CA-backed listener serves GraphQL and WebSocket upgrades",
      trust: "Client proof runs in a fresh Node process with NODE_EXTRA_CA_CERTS set to StackSim's durable loopback CA; client configuration itself is exactly Amplify.configure(parsed amplify_outputs.json)",
      noFabricatedField: "The generator emits no realtime field; AMX-09 does not add one",
    },
    clientProof: {
      package: "aws-amplify@6.20.0",
      configuration: "Amplify.configure(JSON.parse(readFile(amplify_outputs.json)))",
      generatedModel: "client.models.Todo",
      operations: ["create", "get", "list", "filter", "scoped pagination", "conditional error", "duplicate error", "update", "delete", "onCreate", "onUpdate", "onDelete"],
      authorization: ["API_KEY default remains enforced", "AWS_IAM additional remains enforced", "no field-authorization bypass"],
    },
    lifecycle: {
      restart: "Reopen the same durable data root and listener ports; stack IDs, physical IDs, output identity, and client usability remain unchanged",
      deletion: "Signed DeleteStack uses the recursive executor and production providers in reverse dependency-safe order; owned workload reaches DELETE_COMPLETE and bootstrap/unrelated state remains",
      isolation: ["account", "Region", "root/child stack ownership", "sandbox identifier", "AppSync API ID", "API key", "resource generation", "pagination scope"],
      outputFailures: ["missing", "invalid schema", "wrong endpoint generation", "wrong API key", "mixed generation", "tampered", "stale after delete"],
    },
    signals: {
      allowed: ["safe signed control-plane action names/result classes", "stack/resource statuses", "safe physical IDs", "output key names", "redacted output shape", "payload-free client pass/fail booleans", "payload-free realtime diagnostics"],
      forbidden: ["credentials", "session tokens", "SigV4 material", "authorization headers", "API-key values", "callback tokens", "raw policies", "GraphQL documents", "variables", "application records", "resolver private context", "output-file secrets"],
      redactions: ["ApiKey output values become <redacted>", "raw output digest is not retained", "trust and inline policies are summarized by names/actions only", "client evidence contains booleans only"],
    },
    inventories: {
      implementation: ["src/cloudformation.ts", "src/cloudformation/bootstrap.ts", "src/cloudformation/providers/lambda-function.ts", "src/server.ts"],
      actions: "docs/designs/amplify-action-inventory.md; AMX-09 adds GetTemplateSummary, S3 GetObject, DeleteStack, and provider ListFunctions",
      resources: "docs/designs/amplify-resource-inventory.md and graph-manifest.json",
      outputs: "expected-output.schema.json, endpoint-derivation.json, and this manifest's outputs section",
      signals: "this manifest's signals section and payload-free capture summary",
      client: "scripts/exercise-amplify-output.mjs and this manifest's clientProof section",
      utilities: "Generated VTL/model utilities remain byte-protected in amx07-data-manifest.json and amx08-realtime-manifest.json; AMX-09 adds no resolver utility",
      designStatus: "docs/designs/amplify-design.md and docs/designs/implemented-phases.md",
    },
    negativeSurface: [
      "AMX-10 rerun/update/hotswap workflow behavior", "AMX-11 recovery hardening", "AMX-02A Amplify control plane", "Auth/Identity/Storage/Function phases",
      "broader APS-07 authorization modes", "Cognito/Lambda/OIDC AppSync auth", "enhanced subscription filters/invalidation", "AppSync Events",
    ],
  };
}

async function buildEvidence(projection) {
  const amx04HelperManifest = await json(join(evidence, "amx04-helper-manifest.json"));
  const { packageJson, dependencyManifest, fixtureSourceManifest } = projection;
  const rawAssembly = await json(join(out, "manifest.json"));
  const assetFile = (await readdir(out)).find(name => name.endsWith(".assets.json"));
  if (!assetFile) throw new Error("Amplify CDK asset manifest is missing");
  const rawAssetManifest = await json(join(out, assetFile));
  const volatileAssetIds = new Map();
  for (const [id, asset] of Object.entries(rawAssetManifest.files ?? {})) {
    if (asset.displayName === "data Nested Stack Template") volatileAssetIds.set(id, "<data-template-asset-hash>");
    if (asset.displayName.endsWith("-amx01-sandbox-26187e8ba5 Template")) volatileAssetIds.set(id, "<root-template-asset-hash>");
  }
  const replacements = [...volatileAssetIds];
  const assembly = replaceStrings(rawAssembly, replacements);
  const assetManifestSource = structuredClone(rawAssetManifest);
  for (const [id, token] of volatileAssetIds) {
    const asset = assetManifestSource.files[id];
    const destination = Object.values(asset.destinations)[0];
    asset.destinations = { [`current_account-current_region-${token.slice(1, -1)}-destination`]: destination };
  }
  const assetManifest = replaceStrings(assetManifestSource, replacements);
  const templateFiles = (await readdir(out)).filter(name => name.endsWith("template.json")).sort();
  const templates = [];
  for (const file of templateFiles) {
    let document = replaceStrings(await json(join(out, file)), replacements);
    for (const resource of Object.values(document.Resources ?? {})) {
      if (resource.Type === "AWS::AppSync::ApiKey" && typeof resource.Properties?.Expires === "number") {
        resource.Properties.Expires = "<synthesis-time-plus-30-days-epoch-seconds>";
      }
    }
    templates.push({ kind: templateKind(document, file), sourceFile: file, document });
  }
  templates.sort((a, b) => ["root", "data", "table-manager", "todo"].indexOf(a.kind) - ["root", "data", "table-manager", "todo"].indexOf(b.kind));

  const resources = [];
  const iamEdges = [];
  const outputs = [];
  const lambdas = [];
  const stateMachines = [];
  const customResources = [];
  for (const template of templates) {
    for (const [logicalId, resource] of Object.entries(template.document.Resources ?? {})) {
      resources.push({ template: template.kind, logicalId, type: resource.Type, properties: resource.Properties ?? {}, dependsOn: resource.DependsOn ?? null, deletionPolicy: resource.DeletionPolicy ?? null, updateReplacePolicy: resource.UpdateReplacePolicy ?? null });
      iamEdges.push(...collectIam(template.kind, logicalId, resource));
      if (resource.Type === "AWS::Lambda::Function") lambdas.push({ template: template.kind, logicalId, runtime: resource.Properties?.Runtime, handler: resource.Properties?.Handler, code: resource.Properties?.Code, layers: resource.Properties?.Layers ?? [], environmentKeys: Object.keys(resource.Properties?.Environment?.Variables ?? {}).sort(), role: resource.Properties?.Role });
      if (resource.Type === "AWS::StepFunctions::StateMachine") {
        const definition = resource.Properties?.DefinitionString ?? resource.Properties?.Definition;
        const definitionText = JSON.stringify(definition);
        const integrations = [...new Set(definitionText.match(/arn:aws:states:::[^"\\]+/g) ?? [])].sort();
        if (definitionText.includes('"Type\\":\\"Task\\"') && definitionText.includes("Fn::GetAtt")) integrations.push("direct-lambda-arn-task");
        stateMachines.push({ template: template.kind, logicalId, roleArn: resource.Properties?.RoleArn, definition, integrations });
      }
      if (resource.Type.startsWith("Custom::")) customResources.push({ template: template.kind, logicalId, type: resource.Type, serviceToken: resource.Properties?.ServiceToken ?? null, callbackProtocol: resource.Type === "Custom::AmplifyDynamoDBTable" ? "CDK Provider framework onEvent/isComplete polling through Lambda and Step Functions" : "CloudFormation custom-resource request/response through Lambda provider" });
    }
    for (const [name, value] of Object.entries(template.document.Outputs ?? {})) outputs.push({ template: template.kind, name, definition: value });
  }

  const assets = [];
  for (const [rawId, rawAsset] of Object.entries(rawAssetManifest.files ?? {})) {
    const assetSource = structuredClone(rawAsset);
    if (volatileAssetIds.has(rawId)) {
      const token = volatileAssetIds.get(rawId);
      const destination = Object.values(assetSource.destinations)[0];
      assetSource.destinations = { [`current_account-current_region-${token.slice(1, -1)}-destination`]: destination };
    }
    const asset = replaceStrings(assetSource, replacements);
    const id = volatileAssetIds.get(rawId) ?? rawId;
    const sourcePath = join(out, rawAsset.source.path);
    let digest = await digestPath(sourcePath);
    if (volatileAssetIds.has(rawId)) {
      const kind = rawAsset.displayName === "data Nested Stack Template" ? "data" : "root";
      const normalizedTemplate = templates.find(template => template.kind === kind)?.document;
      const content = stableJson(normalizedTemplate);
      digest = { sha256: sha(content), bytes: Buffer.byteLength(content), files: 1 };
    }
    assets.push({ id, displayName: asset.displayName, packaging: asset.source.packaging, sourcePath: asset.source.path, ...digest, destinations: asset.destinations });
  }
  assets.sort((a, b) => a.id.localeCompare(b.id));

  const trace = await json(tracePath);
  const existingOptionalNetwork = trace.result ? null : await json(join(evidence, "optional-network.json"));
  const existingSynthesisOnly = trace.result ? null : await json(join(evidence, "synthesis-only.json"));
  const synthesisTrace = synthesisTracePath ? await json(synthesisTracePath) : null;
  const callsWithNormalizedActions = replaceStrings(trace.calls, replacements).map(call => {
    if (call.service === "s3" && call.path.endsWith("?location=")) return { ...call, action: "GetBucketLocation" };
    if (call.service === "s3" && call.path.endsWith("?encryption=")) return { ...call, action: "GetBucketEncryption" };
    return call;
  });
  const bootstrapProbe = call => call.service === "s3" && ["GetBucketLocation", "GetBucketEncryption"].includes(call.action);
  const normalizedCalls = callsWithNormalizedActions.filter(call => !bootstrapProbe(call)).sort((a, b) =>
    [a.phase, a.service, a.action, a.method, a.path, a.assumedRole ?? "", a.resultClass]
      .join("|")
      .localeCompare([b.phase, b.service, b.action, b.method, b.path, b.assumedRole ?? "", b.resultClass].join("|")));
  normalizedCalls.push(...["GetBucketEncryption", "GetBucketLocation"].map(action => ({
    phase: "sandbox-once",
    service: "s3",
    action,
    method: "GET",
    path: `/cdk-hnb659fds-assets-000000000000-eu-west-1/?${action === "GetBucketEncryption" ? "encryption" : "location"}=`,
    signingName: "s3",
    account: "000000000000",
    region: "eu-west-1",
    hostClass: "approved-loopback",
    assumedRole: "arn:aws:iam::000000000000:role/cdk-hnb659fds-file-publishing-role-000000000000-eu-west-1",
    resultClass: "success",
    occurrence: "variable duplicate calls observed across exact-version runs because concurrent CDK asset publisher clients cache bootstrap bucket metadata independently; one semantic representative is frozen",
  })));
  normalizedCalls.sort((a, b) => [a.phase, a.service, a.action, a.method, a.path, a.assumedRole ?? "", a.resultClass].join("|").localeCompare([b.phase, b.service, b.action, b.method, b.path, b.assumedRole ?? "", b.resultClass].join("|")));
  const traceEvidence = trace.result ? {
    command: "node <pinned ampx.js> sandbox --once --identifier amx01",
    cliExitCode: trace.result.code,
    firstUnsupported: "AWS::SSM::Parameter in the data nested stack (ValidationError from recursive CloudFormation deployment)",
    firstUnsupportedOwner: "AMX-03 admission, then AMX-04 infrastructure execution",
    preSandboxAmplifyServiceCall: trace.calls.some(call => call.service === "amplify"),
    amx02aActivated: trace.calls.some(call => call.service === "amplify"),
    calls: normalizedCalls,
    stateAfterFailure: trace.stateSummary,
    cliOutputClassification: {
      stdout: "not frozen because progress/timing text is non-semantic",
      stderr: "not frozen because terminal formatting is non-semantic; modeled failure is frozen above",
    },
  } : trace;
  const graph = { resources, customResources, lambdas, stateMachines, iamEdges, outputs };
  const amx06AuthorizationManifest = await amx06Manifest(graph, assets);
  const amx07DataManifest = await amx07Manifest(graph, assets);
  const protectedEvidence = Object.fromEntries((await Promise.all([
    "graph-manifest.json", "amx04-helper-manifest.json", "amx05-appsync-manifest.json",
    "amx06-authorization-manifest.json", "amx07-data-manifest.json",
  ].map(async path => [path, sha(await readFile(join(evidence, path)))]))).sort(([left], [right]) => left.localeCompare(right)));
  const amx08RealtimeManifest = await amx08Manifest(graph, assets, protectedEvidence);
  const amx09ProtectedEvidence = Object.fromEntries((await Promise.all([
    "graph-manifest.json", "amx04-helper-manifest.json", "amx05-appsync-manifest.json", "amx06-authorization-manifest.json", "amx07-data-manifest.json", "amx08-realtime-manifest.json",
  ].map(async path => [path, sha(await readFile(join(evidence, path)))]))).sort(([left], [right]) => left.localeCompare(right)));
  const amx09DeploymentManifest = amx09Manifest(amx09ProtectedEvidence);

  return {
    packageJson,
    files: new Map([
      ["amx04-helper-manifest.json", amx04HelperManifest],
      ["amx05-appsync-manifest.json", amx05Manifest({ resources, customResources, lambdas, stateMachines, iamEdges, outputs }, templates, assets)],
      ["amx06-authorization-manifest.json", amx06AuthorizationManifest],
      ["amx07-data-manifest.json", amx07DataManifest],
      ["amx08-realtime-manifest.json", amx08RealtimeManifest],
      ["amx09-deployment-manifest.json", amx09DeploymentManifest],
      ["dependency-manifest.json", dependencyManifest],
      ["fixture-source-manifest.json", fixtureSourceManifest],
      ["cloud-assembly.json", assembly],
      ["asset-manifest.json", assetManifest],
      ["assets-manifest.json", { assets }],
      ["graph-manifest.json", { stackDependencies: Object.fromEntries(Object.entries(assembly.artifacts).map(([name, artifact]) => [name, artifact.dependencies ?? []])), resources, customResources, lambdas, stateMachines, iamEdges, passRoleEdges: iamEdges.filter(edge => edge.actions.includes("iam:PassRole")), outputs }],
      ["expected-output.schema.json", outputSchema()],
      ["endpoint-derivation.json", endpointEvidence()],
      ["normalization.json", {
        rule: "The unmodified backend computes AWS::AppSync::ApiKey Expires as synthesis wall-clock time plus 30 days.",
        normalizedProperty: "data template AWS::AppSync::ApiKey.Properties.Expires",
        derivedValues: ["data nested-template asset hash", "root template references/hash", "asset upload paths for those two templates"],
        invariant: "All other template properties, logical IDs, assets, calls, resources, and outputs remain exact.",
        originalArtifactsAreRewritten: false,
      }],
      ["aws-call-trace.json", traceEvidence],
      ...(existingSynthesisOnly ? [["synthesis-only.json", existingSynthesisOnly]] : synthesisTrace ? [["synthesis-only.json", {
        command: "node <pinned ampx.js> sandbox --once --identifier amx01 (CloudFormation mutation denied by evidence harness)",
        result: { code: synthesisTrace.result.code, signal: synthesisTrace.result.signal },
        stateAfterRun: synthesisTrace.stateSummary,
        firstBlockedMutation: synthesisTrace.calls.find(call => call.resultClass === "blocked:synthesis-only-no-workload-mutation") ?? null,
        workloadMutation: synthesisTrace.stateSummary.stacks !== 0 || synthesisTrace.stateSummary.functions !== 0 || synthesisTrace.stateSummary.tables !== 0 || synthesisTrace.stateSummary.appsyncApis !== 0,
        networkHostClasses: [...new Set(synthesisTrace.calls.map(call => call.hostClass))].sort(),
      }]] : []),
      ["optional-network.json", existingOptionalNetwork ?? {
        attempts: trace.optionalNetwork,
        isolation: trace.isolation,
        sourceProof: {
          telemetryOptOut: "@aws-amplify/platform-core/lib/telemetry/telemetry_span_processor_factory.js and lib/usage-data/usage_data_emitter_factory.js read AMPLIFY_DISABLE_TELEMETRY",
          noticesOverride: "@aws-amplify/backend-cli/lib/notices/notices_manifest_fetcher.js reads AMPLIFY_BACKEND_NOTICES_ENDPOINT",
          windowsConfigIsolation: "@aws-amplify/platform-core/lib/config/get_config_dir_path.js roots configuration under APPDATA/amplify/Config",
        },
        awsDependenciesExcludeOptionalAttempts: true,
      }],
    ]),
    templates,
    assets,
    graph,
    trace: traceEvidence,
  };
}

async function materialize(built, target) {
  await rm(target, { recursive: true, force: true });
  await mkdir(join(target, "templates"), { recursive: true });
  await mkdir(join(target, "assets"), { recursive: true });
  for (const [name, value] of built.files) await writeFile(join(target, name), stableJson(value), "utf8");
  for (const template of built.templates) await writeFile(join(target, "templates", `${template.kind}.json`), stableJson(template.document), "utf8");
  for (const asset of built.assets) {
    const extension = extname(asset.sourcePath);
    if ([".vtl", ".graphql"].includes(extension)) await copyFile(join(out, asset.sourcePath), join(target, "assets", `${asset.id}${extension}`));
  }
  for (const asset of built.assets.filter(item => item.sourcePath.startsWith("asset."))) {
    if (!(await stat(join(out, asset.sourcePath))).isDirectory()) continue;
    for (const file of await filesUnder(join(out, asset.sourcePath))) {
      if (!["model-schema.graphql", "modelIntrospectionSchema.json"].includes(file.split(/[\\/]/).at(-1))) continue;
      const name = `${asset.id}-${posix(relative(join(out, asset.sourcePath), file)).replaceAll("/", "--")}`;
      await copyFile(file, join(target, "assets", name));
    }
  }
  const manifestEntries = [];
  for (const file of await filesUnder(target)) {
    const content = await readFile(file);
    manifestEntries.push({ path: posix(relative(target, file)), sha256: sha(content), bytes: content.length });
  }
  await writeFile(join(target, "evidence-manifest.json"), stableJson({ format: 1, milestone: "AMX-M0 frozen evidence plus protected AMX-04 through AMX-08 manifests and AMX-09 complete frozen deployment/output evidence", files: manifestEntries }), "utf8");
}

async function comparable(target) {
  const result = new Map();
  for (const file of await filesUnder(target)) {
    const path = posix(relative(target, file));
    result.set(path, sha(await readFile(file)));
  }
  return result;
}

const projection = await currentProjection();
const currentAwsCdkLib = projection.packageJson.devDependencies?.["aws-cdk-lib"];
if (currentAwsCdkLib !== frozenSynthesisProvenance.awsCdkLib) {
  if (writeMode) {
    throw new Error(`Refusing to overwrite the protected aws-cdk-lib ${frozenSynthesisProvenance.awsCdkLib} synthesis corpus from the current ${currentAwsCdkLib ?? "unversioned"} fixture; update frozenSynthesisProvenance only as part of an atomic corpus migration`);
  }
  await verifyCurrentProjection(projection);
  console.log(`AMX-01 current clean-install projection matches and the protected aws-cdk-lib ${frozenSynthesisProvenance.awsCdkLib} synthesis corpus remains unchanged`);
} else {
  const built = await buildEvidence(projection);
  if (writeMode) {
    await materialize(built, evidence);
    await writeFile(join(root, "docs", "designs", "amplify-resource-inventory.md"), resourceInventory(built.graph), "utf8");
    await writeFile(join(root, "docs", "designs", "amplify-action-inventory.md"), actionInventory(built.trace), "utf8");
    console.log(`wrote AMX-01 through AMX-09 evidence to ${evidence}`);
  } else {
    const temp = join(fixture, ".amplify", "amx01-evidence-check");
    await materialize(built, temp);
    const expected = await comparable(evidence);
    const actual = await comparable(temp);
    const paths = [...new Set([...expected.keys(), ...actual.keys()])].sort();
    const drift = paths.filter(path => expected.get(path) !== actual.get(path));
    if (drift.length) throw new Error(`AMX-01 evidence drift: ${drift.join(", ")}`);
    await rm(temp, { recursive: true, force: true });
    console.log(`AMX-01 evidence matches ${paths.length} frozen files`);
  }
}
