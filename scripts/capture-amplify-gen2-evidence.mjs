import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, request } from "node:http";
import { cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CloudFormationClient, CreateStackCommand, DeleteStackCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { StackSim } from "../dist/src/server.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselineFixture = join(sourceRoot, "test", "fixtures", "amplify-gen2-data");
let fixture = baselineFixture;
const tripwire = join(sourceRoot, "test", "fixtures", "cdk", "network-tripwire.cjs");
const region = "eu-west-1";
const accountId = "000000000000";

function signingScope(value) {
  const match = value?.match(/Credential=([^/,\s]+)\/\d{8}\/([^/]+)\/([^/]+)\/aws4_request/);
  return { accessKeyId: match?.[1] ?? "unsigned", region: match?.[2] ?? "unknown", service: match?.[3] ?? "unknown" };
}

function queryAction(body) {
  try { return new URLSearchParams(body.toString("utf8")).get("Action") ?? "unknown"; }
  catch { return "unknown"; }
}

function actionFor(service, method, path, target, body) {
  if (target) return target.slice(target.lastIndexOf(".") + 1);
  const url = new URL(path, "http://local");
  if (service === "appsync") {
    if (/\/schemacreation$/.test(url.pathname)) return method === "POST" ? "StartSchemaCreation" : "GetSchemaCreationStatus";
    if (/\/functions\/[^/]+$/.test(url.pathname)) return method === "POST" ? "UpdateFunction" : "GetFunction";
    if (/\/functions$/.test(url.pathname)) return "ListFunctions";
    if (/\/resolvers\/[^/]+$/.test(url.pathname)) return method === "POST" ? "UpdateResolver" : "GetResolver";
    if (/\/apikeys\/[^/]+$/.test(url.pathname)) return method === "POST" ? "UpdateApiKey" : "DeleteApiKey";
  }
  if (service === "lambda") {
    if (/\/code$/.test(url.pathname)) return "UpdateFunctionCode";
    if (/\/configuration$/.test(url.pathname)) return method === "PUT" ? "UpdateFunctionConfiguration" : "GetFunctionConfiguration";
    if (/\/invocations$/.test(url.pathname)) return "Invoke";
  }
  if (service === "s3") {
    if (method === "HEAD") return url.pathname === "/" ? "HeadBucket" : "HeadObject";
    if (method === "GET" && url.searchParams.has("location")) return "GetBucketLocation";
    if (method === "GET" && url.searchParams.has("encryption")) return "GetBucketEncryption";
    if (method === "GET" && url.searchParams.has("list-type")) return "ListObjectsV2";
    if (method === "GET" && url.searchParams.has("versions")) return "ListObjectVersions";
    if (method === "GET") return "GetObject";
    if (method === "PUT" && url.searchParams.has("partNumber")) return "UploadPart";
    if (method === "PUT") return "PutObject";
    if (method === "POST" && url.searchParams.has("uploads")) return "CreateMultipartUpload";
    if (method === "POST" && url.searchParams.has("uploadId")) return "CompleteMultipartUpload";
    if (method === "DELETE" && url.searchParams.has("uploadId")) return "AbortMultipartUpload";
    return `${method}ObjectOrBucket`;
  }
  return queryAction(body);
}

function normalizedPath(path) {
  const url = new URL(path, "http://local");
  if (url.searchParams.has("uploadId")) url.searchParams.set("uploadId", "<upload-id>");
  return `${url.pathname}${url.search}`;
}

function resultClass(statusCode, body) {
  if (statusCode < 400) return "success";
  const text = body.toString("utf8");
  const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1]
    ?? text.match(/\"(?:__type|code|Code)\"\s*:\s*\"(?:[^\"#]+#)?([^\"]+)\"/)?.[1];
  return code ? `error:${code}` : `http-${statusCode}`;
}

function assumeRoleArn(body) {
  try { return new URLSearchParams(body.toString("utf8")).get("RoleArn"); }
  catch { return null; }
}

function assumedAccessKey(body) {
  return body.toString("utf8").match(/<AccessKeyId>([^<]+)<\/AccessKeyId>/)?.[1] ?? null;
}

async function listen(server) {
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()));
}

async function createTracingProxy(upstreamPort, calls, synthesisOnly, currentPhase) {
  const rolesByAccessKey = new Map();
  const proxy = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const scope = signingScope(incoming.headers.authorization);
    const method = incoming.method ?? "GET";
    const path = incoming.url ?? "/";
    const action = actionFor(scope.service, method, path, incoming.headers["x-amz-target"]?.toString(), body);
    const requestedRole = scope.service === "sts" && action === "AssumeRole" ? assumeRoleArn(body) : null;
    const call = {
      phase: currentPhase(),
      service: scope.service,
      action,
      method,
      path: normalizedPath(path),
      signingName: scope.service,
      account: accountId,
      region: scope.region,
      hostClass: "approved-loopback",
      assumedRole: rolesByAccessKey.get(scope.accessKeyId) ?? requestedRole,
    };
    calls.push(call);
    if (synthesisOnly && scope.service === "cloudformation" && ["CreateStack", "CreateChangeSet", "ExecuteChangeSet", "UpdateStack"].includes(action)) {
      call.resultClass = "blocked:synthesis-only-no-workload-mutation";
      outgoing.writeHead(403, { "content-type": "text/xml" });
      outgoing.end("<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>AMX-01 synthesis-only mutation tripwire</Message></Error><RequestId>amx01-synthesis-only</RequestId></ErrorResponse>");
      return;
    }
    const forwarded = request({
      host: "127.0.0.1",
      port: upstreamPort,
      method,
      path,
      headers: incoming.headers,
    }, response => {
      const responseChunks = [];
      response.on("data", chunk => responseChunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const responseBody = Buffer.concat(responseChunks);
        call.resultClass = resultClass(response.statusCode ?? 502, responseBody);
        if (requestedRole && response.statusCode && response.statusCode < 400) {
          const accessKey = assumedAccessKey(responseBody);
          if (accessKey) rolesByAccessKey.set(accessKey, requestedRole);
        }
        outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, response.headers);
        outgoing.end(responseBody);
      });
    });
    forwarded.on("error", error => {
      call.resultClass = "proxy-error";
      outgoing.writeHead(502, { "content-type": "text/plain" });
      outgoing.end(`local trace proxy failed: ${error.message}`);
    });
    forwarded.end(body);
  });
  const port = await listen(proxy);
  return { proxy, endpoint: `http://127.0.0.1:${port}`, port };
}

async function listFiles(root) {
  const result = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else result.push(relative(root, full).replaceAll("\\", "/"));
    }
  }
  await visit(root);
  return result.sort();
}

async function exerciseAmplifyClient(output, simulator, label, mode = "full") {
  void output;
  const helper = resolve(sourceRoot, "scripts", "exercise-amplify-output.mjs");
  const ca = join(simulator.store.root, "data", "cloudformation", "custom-resource-pki", "ca.pem");
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [helper, join(fixture, "amplify_outputs.json"), label, mode], {
      cwd: sourceRoot,
      env: { ...process.env, NODE_EXTRA_CA_CERTS: ca },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", code => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) reject(new Error(`Amplify client helper failed (${code}): ${err || out}`));
      else try { resolvePromise(JSON.parse(out)); } catch (error) { reject(error); }
    });
  });
}

function safeOutputEvidence(raw, output) {
  const endpoint = new URL(output.data.url);
  const apiId = endpoint.pathname.split("/").filter(Boolean).at(-1);
  const redacted = structuredClone(output);
  if (redacted.data?.api_key) redacted.data.api_key = "<redacted>";
  return {
    cliPath: "amplify_outputs.json",
    cliWriteObserved: true,
    version: output.version,
    topLevelKeys: Object.keys(output).sort(),
    dataKeys: Object.keys(output.data ?? {}).sort(),
    region: output.data?.aws_region,
    graphqlUrl: output.data?.url,
    realtimeDerivation: `${endpoint.protocol === "https:" ? "wss:" : "ws:"}//${endpoint.host}${endpoint.pathname.replace(/\/$/, "")}/realtime`,
    apiId,
    defaultAuthorizationType: output.data?.default_authorization_type,
    authorizationTypes: output.data?.authorization_types,
    apiKey: { present: typeof output.data?.api_key === "string", length: output.data?.api_key?.length ?? 0, value: "<redacted>" },
    modelIntrospection: { version: output.data?.model_introspection?.version, models: Object.keys(output.data?.model_introspection?.models ?? {}).sort() },
    digestRule: "sha256 of canonical generated output after replacing data.api_key with <redacted>",
    redactedDigest: createHash("sha256").update(JSON.stringify(redacted)).digest("hex"),
    byteLength: Buffer.byteLength(raw),
  };
}

function safeStackGraph(regional) {
  return Object.values(regional.cloudformation.stacks)
    .filter(stack => stack.stackName.startsWith("amplify-"))
    .sort((left, right) => left.stackName.localeCompare(right.stackName))
    .map(stack => ({
      stackId: stack.stackId,
      stackName: stack.stackName,
      status: stack.stackStatus,
      parentId: stack.parentId ?? null,
      rootId: stack.rootId ?? stack.stackId,
      parentLogicalId: stack.parentLogicalId ?? null,
      resources: Object.values(stack.resources).sort((left, right) => left.logicalResourceId.localeCompare(right.logicalResourceId)).map(resource => ({
        logicalId: resource.logicalResourceId,
        type: resource.resourceType,
        status: resource.resourceStatus,
        physicalId: resource.physicalResourceId,
        attributeNames: Object.keys(resource.attributes ?? {}).filter(name => !/key/i.test(name)).sort(),
      })),
      outputs: (stack.outputs ?? []).map(output => ({
        key: output.outputKey,
        value: /key/i.test(output.outputKey ?? "") ? "<redacted>" : output.outputValue,
      })),
      stabilization: stack.events.slice().reverse().map(event => ({ logicalId: event.logicalResourceId, type: event.resourceType, status: event.resourceStatus })),
    }));
}

async function run() {
  const synthesisOnly = process.argv.includes("--synthesis-only");
  const authEnforce = process.argv.includes("--auth-enforce");
  const watchEdit = process.argv.includes("--watch-edit");
  const tempRoot = await mkdtemp(join(tmpdir(), "stacksim-amx01-probe-"));
  if (watchEdit) {
    fixture = join(tempRoot, "workspace");
    await cp(baselineFixture, fixture, { recursive: true, filter: source => !source.includes(`${join(baselineFixture, "node_modules")}`) && !source.includes(`${join(baselineFixture, ".amplify")}`) && source !== join(baselineFixture, "amplify_outputs.json") });
    await symlink(join(baselineFixture, "node_modules"), join(fixture, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  }
  const simulatorOptions = {
    port: 0,
    invokePort: 0,
    dataDir: join(tempRoot, "data"),
    region,
    authMode: authEnforce ? "enforce" : "off",
    cdkBootstrap: process.argv.includes("--bootstrap"),
    appSyncLocalTls: process.argv.includes("--appsync-tls"),
  };
  let simulator = new StackSim(simulatorOptions);
  const calls = [];
  const optionalNetwork = [];
  let phase = "sandbox-once";
  let proxy;
  let notices;
  try {
    await simulator.start();
    proxy = await createTracingProxy(simulator.port, calls, synthesisOnly, () => phase);
    notices = createServer((incoming, response) => {
      optionalNetwork.push({
        category: "amplify-notices-update-check",
        method: incoming.method ?? "GET",
        path: incoming.url ?? "/",
        hostClass: "approved-loopback",
        resultClass: "success-empty-manifest",
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"notices":[]}');
    });
    const noticesPort = await listen(notices);
    const inherited = { ...process.env };
    for (const key of Object.keys(inherited)) {
      if (key === "AWS_ENDPOINT_URL" || key.startsWith("AWS_ENDPOINT_URL_") || ["AWS_PROFILE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].includes(key)) delete inherited[key];
    }
    const packageManager = JSON.parse(await readFile(join(fixture, "package.json"), "utf8")).packageManager.replace("@", "/");
    let env = {
      ...inherited,
      AWS_ACCESS_KEY_ID: "admin",
      AWS_SECRET_ACCESS_KEY: "password",
      AWS_REGION: region,
      AWS_DEFAULT_REGION: region,
      AWS_ENDPOINT_URL: proxy.endpoint,
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_MAX_ATTEMPTS: "1",
      AWS_CONFIG_FILE: join(tempRoot, "no-aws-config"),
      AWS_SHARED_CREDENTIALS_FILE: join(tempRoot, "no-aws-credentials"),
      CDK_DEFAULT_ACCOUNT: accountId,
      CDK_DEFAULT_REGION: region,
      CDK_DISABLE_CLI_TELEMETRY: "true",
      CDK_DISABLE_VERSION_CHECK: "true",
      AMPLIFY_DISABLE_TELEMETRY: "1",
      AMPLIFY_BACKEND_NOTICES_ENDPOINT: `http://127.0.0.1:${noticesPort}/notices.json`,
      APPDATA: join(tempRoot, "appdata"),
      npm_config_update_notifier: "false",
      // Amplify requires the package-manager token, but Node and OS identity
      // must come from neither the host nor a fabricated frozen user-agent.
      npm_config_user_agent: packageManager,
      CI: "1",
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
      STACKSIM_NETWORK_ALLOW_PORT: `${proxy.port},${noticesPort}`,
      NODE_OPTIONS: `${inherited.NODE_OPTIONS ?? ""} --require=${tripwire}`.trim(),
    };
    const cli = join(fixture, "node_modules", "@aws-amplify", "backend-cli", "lib", "ampx.js");
    const identifierIndex = process.argv.indexOf("--identifier");
    const identifier = identifierIndex >= 0 ? process.argv[identifierIndex + 1] : watchEdit ? "amx10a" : "amx01";
    const generatedOutputPath = join(fixture, "amplify_outputs.json");
    await rm(generatedOutputPath, { force: true });
    const unrelatedStackName = "amx09-unrelated-stack";
    if (process.argv.includes("--delete")) {
      phase = "isolation-setup";
      const cloudformation = new CloudFormationClient({ endpoint: proxy.endpoint, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 });
      try {
        await cloudformation.send(new CreateStackCommand({
          StackName: unrelatedStackName,
          TemplateBody: JSON.stringify({ Resources: { Metadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: "amx09-unrelated" } } } }),
        }));
        let created = false;
        for (let attempt = 0; attempt < 1_000; attempt += 1) {
          const described = (await cloudformation.send(new DescribeStacksCommand({ StackName: unrelatedStackName }))).Stacks?.[0];
          if (described?.StackStatus === "CREATE_COMPLETE") { created = true; break; }
          await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
        }
        if (!created) throw new Error("Timed out creating the unrelated AMX-09 isolation stack");
      } finally { cloudformation.destroy(); }
      phase = "sandbox-once";
    }
    let watchEvidence;
    const runCli = () => new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [cli, "sandbox", ...(watchEdit ? [] : ["--once"]), "--identifier", identifier], {
        cwd: fixture,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = [];
      const stderr = [];
      child.stdout.on("data", chunk => { stdout.push(Buffer.from(chunk)); if (watchEdit) process.stderr.write(chunk); });
      child.stderr.on("data", chunk => { stderr.push(Buffer.from(chunk)); if (watchEdit) process.stderr.write(chunk); });
      const stopChild = () => {
        if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
        else child.kill("SIGTERM");
      };
      const timer = setTimeout(stopChild, watchEdit ? 420_000 : 240_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolvePromise({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      });
      if (watchEdit) void (async () => {
        try {
          for (let attempt = 0; attempt < 3_000; attempt += 1) {
            const root = Object.values(simulator.store.regionState(region).cloudformation.stacks).find(stack => !stack.parentId && stack.stackName.includes(identifier));
            const watchReady = Buffer.concat(stdout).toString("utf8").includes("Watching for file changes");
            if (root?.stackStatus === "CREATE_COMPLETE" && watchReady) {
              try { await readFile(generatedOutputPath, "utf8"); break; } catch {}
            }
            await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
          }
          process.stderr.write("\n[AMX-10] baseline watch deployment ready; applying isolated scalar edit\n");
          const beforeGraph = safeStackGraph(simulator.store.regionState(region));
          const beforeOutput = await readFile(generatedOutputPath, "utf8");
          const beforeCalls = calls.length;
          const beforeWatchReady = (Buffer.concat(stdout).toString("utf8").match(/Watching for file changes/g) ?? []).length;
          const beforeRoot = Object.values(simulator.store.regionState(region).cloudformation.stacks).find(stack => !stack.parentId && stack.stackName.includes(identifier));
          const beforeEvents = beforeRoot?.events.length ?? 0;
          phase = "watch-supported-scalar-edit";
          const resourcePath = join(fixture, "amplify", "data", "resource.ts");
          const original = await readFile(resourcePath, "utf8");
          await writeFile(resourcePath, original.replace("      description: a.string(),", "      description: a.string(),\n      notes: a.string(),"), "utf8");
          let quietSince = Date.now(); let observedCalls = beforeCalls;
          for (let attempt = 0; attempt < 6_000; attempt += 1) {
            if (calls.length !== observedCalls) { observedCalls = calls.length; quietSince = Date.now(); }
            const directOrFallback = calls.slice(beforeCalls).some(call => call.phase === phase && (call.service === "appsync" && ["StartSchemaCreation", "UpdateFunction", "UpdateResolver"].includes(call.action) || call.service === "lambda" && ["UpdateFunctionCode", "UpdateFunctionConfiguration", "Invoke"].includes(call.action) || call.service === "cloudformation" && ["UpdateStack", "CreateChangeSet", "ExecuteChangeSet"].includes(call.action)));
            const deploymentFinished = (Buffer.concat(stdout).toString("utf8").match(/Watching for file changes/g) ?? []).length > beforeWatchReady;
            if (directOrFallback && deploymentFinished && Date.now() - quietSince > 1_000) break;
            await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
          }
          const afterRoot = Object.values(simulator.store.regionState(region).cloudformation.stacks).find(stack => !stack.parentId && stack.stackName.includes(identifier));
          const afterOutput = await readFile(generatedOutputPath, "utf8").catch(() => "");
          watchEvidence = {
            identifier,
            edit: "Todo.notes optional string",
            beforeGraph,
            afterGraph: safeStackGraph(simulator.store.regionState(region)),
            cloudFormationEventsUnchanged: (afterRoot?.events.length ?? 0) === beforeEvents,
            cloudFormationTemplateDigestUnchanged: afterRoot?.templateDigest === beforeRoot?.templateDigest,
            outputRewritten: afterOutput !== beforeOutput,
            calls: calls.slice(beforeCalls),
            ownership: simulator.store.regionState(region).cloudformation.resourceOwnership,
            drift: simulator.store.regionState(region).cloudformation.hotswapDrift,
            operations: simulator.store.regionState(region).cloudformation.hotswapOperations,
          };
          const apiKeyBeforeCalls = calls.length;
          const apiKeyBeforeWatchReady = (Buffer.concat(stdout).toString("utf8").match(/Watching for file changes/g) ?? []).length;
          const apiKeyBeforeRoot = Object.values(simulator.store.regionState(region).cloudformation.stacks).find(stack => !stack.parentId && stack.stackName.includes(identifier));
          const apiKeyBeforeEvents = apiKeyBeforeRoot?.events.length ?? 0;
          const apiKeyBeforeTemplate = apiKeyBeforeRoot?.templateDigest;
          phase = "watch-supported-api-key-edit";
          const backend = await readFile(resourcePath, "utf8");
          await writeFile(resourcePath, backend.replace("expiresInDays: 30", "expiresInDays: 29"), "utf8");
          quietSince = Date.now(); observedCalls = apiKeyBeforeCalls;
          for (let attempt = 0; attempt < 6_000; attempt += 1) {
            if (calls.length !== observedCalls) { observedCalls = calls.length; quietSince = Date.now(); }
            const observed = calls.slice(apiKeyBeforeCalls).some(call => call.phase === phase && (call.service === "appsync" && call.action === "UpdateApiKey" || call.service === "cloudformation" && call.action === "UpdateStack"));
            const deploymentFinished = (Buffer.concat(stdout).toString("utf8").match(/Watching for file changes/g) ?? []).length > apiKeyBeforeWatchReady;
            if (observed && deploymentFinished && Date.now() - quietSince > 1_000) break;
            await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
          }
          const apiKeyAfterRoot = Object.values(simulator.store.regionState(region).cloudformation.stacks).find(stack => !stack.parentId && stack.stackName.includes(identifier));
          watchEvidence.apiKeyEdit = {
            edit: "apiKey expiresInDays 30 to 29",
            calls: calls.slice(apiKeyBeforeCalls),
            cloudFormationEventsUnchanged: (apiKeyAfterRoot?.events.length ?? 0) === apiKeyBeforeEvents,
            cloudFormationTemplateDigestUnchanged: apiKeyAfterRoot?.templateDigest === apiKeyBeforeTemplate,
            drift: simulator.store.regionState(region).cloudformation.hotswapDrift,
            operations: simulator.store.regionState(region).cloudformation.hotswapOperations,
          };
          const unsupportedBeforeCalls = calls.length;
          const unsupportedBeforeOutput = await readFile(generatedOutputPath, "utf8");
          const unsupportedBeforeGraph = safeStackGraph(simulator.store.regionState(region));
          const unsupportedLogOffset = Buffer.concat([...stdout, ...stderr]).length;
          phase = "watch-unsupported-synthesis-edit";
          const supportedBackend = await readFile(resourcePath, "utf8");
          await writeFile(resourcePath, supportedBackend.replace("notes: a.string()", "notes: a.unsupportedScalar()"), "utf8");
          let unsupportedDiagnostic = "";
          for (let attempt = 0; attempt < 3_000; attempt += 1) {
            const combined = Buffer.concat([...stdout, ...stderr]).subarray(unsupportedLogOffset).toString("utf8");
            if (/unsupportedScalar|failed|error|does not exist/i.test(combined)) { unsupportedDiagnostic = combined; break; }
            await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
          }
          await new Promise(resolveDelay => setTimeout(resolveDelay, 500));
          const unsupportedAfterOutput = await readFile(generatedOutputPath, "utf8");
          watchEvidence.unsupportedEdit = {
            edit: "Todo.notes uses nonexistent a.unsupportedScalar()",
            classification: "synthesis rejection before direct mutation",
            diagnosticObserved: /unsupportedScalar|failed|error|does not exist/i.test(unsupportedDiagnostic),
            diagnostic: unsupportedDiagnostic.slice(-4_000),
            calls: calls.slice(unsupportedBeforeCalls),
            backendUnchanged: JSON.stringify(safeStackGraph(simulator.store.regionState(region))) === JSON.stringify(unsupportedBeforeGraph),
            outputUnchanged: unsupportedAfterOutput === unsupportedBeforeOutput,
            priorOutputClientUse: await exerciseAmplifyClient(JSON.parse(unsupportedAfterOutput), simulator, "amx10-unsupported-retained"),
          };
          // The pinned delete command synthesizes before deletion, so restore the isolated
          // fixture after capturing the failure while the watcher is being terminated.
          await writeFile(resourcePath, supportedBackend, "utf8");
          process.stderr.write("\n[AMX-10] edit trace quiesced; stopping watch process\n");
          stopChild();
        } catch (error) { process.stderr.write(`\n[AMX-10] watch harness failed: ${error instanceof Error ? error.stack : error}\n`); stopChild(); reject(error); }
      })();
    });
    const result = await runCli();
    let generatedOutputRaw;
    let generatedOutput;
    let outputEvidence;
    let clientUse;
    let outputIsolation;
    try {
      generatedOutputRaw = await readFile(generatedOutputPath, "utf8");
      generatedOutput = JSON.parse(generatedOutputRaw);
      outputEvidence = safeOutputEvidence(generatedOutputRaw, generatedOutput);
    } catch {
      outputEvidence = null;
    }
    if (generatedOutput && result.code === 0 && /File written: amplify_outputs\.json/.test(result.stdout)) {
      clientUse = await exerciseAmplifyClient(generatedOutput, simulator, "amx09");
      outputIsolation = await exerciseAmplifyClient(generatedOutput, simulator, "amx09-isolation", "negative");
    }
    let secondIdentifierResult;
    const secondIdentifier = process.argv.includes("--second-identifier") ? "amx10b" : undefined;
    if (secondIdentifier) {
      phase = "second-identifier-deploy";
      secondIdentifierResult = await new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, [cli, "sandbox", "--once", "--identifier", secondIdentifier], { cwd: fixture, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        const stdout = []; const stderr = [];
        child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk))); child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
        child.once("error", reject); child.once("close", (code, signal) => resolvePromise({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
      });
      if (secondIdentifierResult.code !== 0) throw new Error(`Second identifier deployment failed: ${secondIdentifierResult.stderr || secondIdentifierResult.stdout}`);
    }
    const firstBootstrap = simulator.store.regionState(region).cloudformation.bootstrap;
    const firstIndex = firstBootstrap
      ? await simulator.s3.storage.loadBucket(accountId, region, firstBootstrap.bucketName)
      : undefined;
    const firstAssetVersions = firstIndex
      ? Object.fromEntries(Object.entries(firstIndex.objects).map(([key, versions]) => [key, versions.filter(version => !version.deleteMarker).length]))
      : {};
    let repeatResult;
    let repeatEvidence;
    if (process.argv.includes("--repeat")) {
      phase = "sandbox-once-repeat";
      const repeatIdentity = () => {
        const regional = simulator.store.regionState(region);
        const stacks = Object.values(regional.cloudformation.stacks).filter(stack => stack.stackName.includes(identifier) || stack.rootId && regional.cloudformation.stacks[stack.rootId]?.stackName.includes(identifier));
        return {
          stacks: stacks.map(stack => ({ stackId: stack.stackId, stackName: stack.stackName, resources: Object.values(stack.resources).map(resource => ({ logicalId: resource.logicalResourceId, physicalId: resource.physicalResourceId, type: resource.resourceType })).sort((left, right) => left.logicalId.localeCompare(right.logicalId)) })).sort((left, right) => left.stackId.localeCompare(right.stackId)),
          serviceCounts: { appsyncApis: Object.keys(regional.appsync.graphqlApis).length, tables: Object.keys(regional.tables).length, functions: Object.keys(regional.functions).length },
        };
      };
      const beforeIdentity = repeatIdentity();
      const beforeOutput = await readFile(generatedOutputPath, "utf8");
      const beforeCalls = calls.length;
      if (process.argv.includes("--restart-before-repeat")) {
        await close(proxy.proxy);
        proxy = undefined;
        await simulator.stop();
        simulator = new StackSim(simulatorOptions);
        await simulator.start();
        proxy = await createTracingProxy(simulator.port, calls, synthesisOnly, () => phase);
        env = {
          ...env,
          AWS_ENDPOINT_URL: proxy.endpoint,
          STACKSIM_NETWORK_ALLOW_PORT: `${proxy.port},${noticesPort}`,
        };
      }
      repeatResult = await runCli();
      const afterIdentity = repeatIdentity();
      const afterOutput = await readFile(generatedOutputPath, "utf8");
      repeatEvidence = {
        command: `sandbox --once --identifier ${identifier}`,
        classification: "pinned harmless reconciliation (the generated API-key expiry is time-relative)",
        calls: calls.slice(beforeCalls),
        physicalIdentityUnchanged: JSON.stringify(afterIdentity) === JSON.stringify(beforeIdentity),
        beforeIdentity,
        afterIdentity,
        outputUnchanged: afterOutput === beforeOutput,
        beforeOutputRedactedDigest: safeOutputEvidence(beforeOutput, JSON.parse(beforeOutput)).redactedDigest,
        afterOutputRedactedDigest: safeOutputEvidence(afterOutput, JSON.parse(afterOutput)).redactedDigest,
      };
    }
    let restart;
    if (process.argv.includes("--restart") && generatedOutput) {
      phase = "restart-client";
      const originalPort = simulator.port;
      const originalInvokePort = simulator.invokePort;
      const originalCallbackPort = simulator.customResourceCallbackPort;
      const before = safeStackGraph(simulator.store.regionState(region));
      await close(proxy.proxy);
      proxy = undefined;
      await simulator.stop();
      simulator = new StackSim({ ...simulatorOptions, port: originalPort, invokePort: originalInvokePort, cloudFormationCustomResourceCallbackPort: originalCallbackPort });
      await simulator.start();
      proxy = await createTracingProxy(simulator.port, calls, synthesisOnly, () => phase);
      env = { ...env, AWS_ENDPOINT_URL: proxy.endpoint, STACKSIM_NETWORK_ALLOW_PORT: `${proxy.port},${noticesPort}` };
      const after = safeStackGraph(simulator.store.regionState(region));
      const restartClient = await exerciseAmplifyClient(generatedOutput, simulator, "amx09-restart");
      restart = {
        stackGraphIdentityPreserved: JSON.stringify(before.map(stack => ({ stackId: stack.stackId, resources: stack.resources.map(resource => [resource.logicalId, resource.physicalId]) })))
          === JSON.stringify(after.map(stack => ({ stackId: stack.stackId, resources: stack.resources.map(resource => [resource.logicalId, resource.physicalId]) }))),
        outputIdentityPreserved: generatedOutput.data.url === outputEvidence.graphqlUrl,
        clientUse: restartClient,
      };
    }
    const artifacts = join(fixture, ".amplify");
    const regional = simulator.store.regionState(region);
    const bootstrap = regional.cloudformation.bootstrap;
    const account = simulator.store.ensureAccount();
    const bootstrapIndex = bootstrap
      ? await simulator.s3.storage.loadBucket(accountId, region, bootstrap.bucketName)
      : undefined;
    const assetObjects = bootstrapIndex
      ? Object.entries(bootstrapIndex.objects).map(([key, versions]) => ({
          key,
          versions: versions.filter(version => !version.deleteMarker).length,
          size: versions.find(version => !version.deleteMarker)?.size ?? 0,
          multipartParts: versions.find(version => !version.deleteMarker)?.parts?.length ?? 0,
        })).sort((left, right) => left.key.localeCompare(right.key))
      : [];
    const bootstrapRoles = bootstrap
      ? Object.entries(bootstrap.roleArns).map(([purpose, arn]) => {
          const role = Object.values(account.iam.roles).find(candidate => candidate.arn === arn);
          return {
            purpose,
            arn,
            roleName: role?.roleName ?? null,
            maxSessionDuration: role?.maxSessionDuration ?? null,
            attachedPolicyArns: role?.attachedPolicyArns ?? [],
            trustSummary: role ? role.assumeRolePolicyDocument.Statement.map(statement => ({
              actions: Array.isArray(statement.Action) ? [...statement.Action].sort() : [statement.Action],
              principalTypes: Object.keys(statement.Principal ?? {}).sort(),
            })) : [],
            inlinePolicyNames: role ? Object.keys(role.inlinePolicies).sort() : [],
          };
        })
      : [];
    const sessions = Object.values(account.iam.sessions).map(session => ({
      roleArn: session.roleArn,
      roleName: session.roleName,
      sessionName: session.sessionName,
      principalArn: session.principalArn,
      expiration: session.expiration,
      sessionTags: session.sessionTags,
    })).sort((left, right) => left.roleArn.localeCompare(right.roleArn) || left.sessionName.localeCompare(right.sessionName));
    const authorizationDecisions = account.iam.authorizationDecisions.map(decision => ({
      principalArn: decision.principalArn,
      action: decision.action,
      resource: decision.resource,
      decision: decision.decision,
      reason: decision.reason,
    }));
    const deploymentStack = Object.values(regional.cloudformation.stacks).find(stack => !stack.parentId && stack.stackName.startsWith("amplify-") && stack.stackName.includes(identifier));
    const recursiveManifest = deploymentStack?.templateArtifactId
      ? JSON.parse(await readFile(join(simulator.store.root, "data", "cloudformation", accountId, region, "artifacts", "plans", `${deploymentStack.templateArtifactId}.nested-templates.json`), "utf8"))
      : undefined;
    const recursiveTemplatePins = [];
    const collectTemplatePins = manifest => {
      for (const asset of manifest?.assets ?? []) {
        recursiveTemplatePins.push({ logicalPath: asset.logicalPath, bucket: asset.bucket, key: asset.key, versionId: asset.versionId, digest: asset.digest, childStackId: asset.childStackId, childStackName: asset.childStackName });
        collectTemplatePins(asset.nestedTemplateManifest);
      }
    };
    collectTemplatePins(recursiveManifest);
    const successfulStackGraph = safeStackGraph(regional);
    let deletion;
    if (process.argv.includes("--delete") && deploymentStack) {
      phase = "ordinary-stack-delete";
      const bootstrapIdentity = {
        bucketName: bootstrap?.bucketName,
        roleArns: bootstrap?.roleArns,
        versionParameterName: bootstrap?.versionParameterName,
      };
      let deleteCliResult;
      if (watchEdit) {
        phase = "sandbox-delete-command";
        deleteCliResult = await new Promise((resolvePromise, reject) => {
          const child = spawn(process.execPath, [cli, "sandbox", "delete", "--identifier", identifier, "--yes"], { cwd: fixture, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
          const stdout = []; const stderr = [];
          child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk))); child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
          child.once("error", reject); child.once("close", (code, signal) => resolvePromise({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
        });
        if (deleteCliResult.code !== 0) throw new Error(`Pinned sandbox delete failed: ${deleteCliResult.stderr || deleteCliResult.stdout}`);
      } else {
        const cloudformation = new CloudFormationClient({ endpoint: proxy.endpoint, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 });
        try {
          await cloudformation.send(new DeleteStackCommand({ StackName: deploymentStack.stackId }));
          let deleted;
          for (let attempt = 0; attempt < 1_000; attempt += 1) {
            const described = (await cloudformation.send(new DescribeStacksCommand({ StackName: deploymentStack.stackId }))).Stacks?.[0];
            if (described?.StackStatus === "DELETE_COMPLETE") { deleted = described; break; }
            await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
          }
          if (!deleted) throw new Error("Timed out waiting for ordinary stack deletion");
        } finally { cloudformation.destroy(); }
      }
      const afterDelete = simulator.store.regionState(region);
      let staleOutputRejected = false;
      try {
        const requireFromFixture = createRequire(join(fixture, "package.json"));
        const { Amplify } = requireFromFixture("aws-amplify");
        const { generateClient } = requireFromFixture("aws-amplify/data");
        Amplify.configure(generatedOutput);
        const stale = await generateClient().models.Todo.list();
        staleOutputRejected = Array.isArray(stale.errors) && stale.errors.length > 0;
      } catch { staleOutputRejected = true; }
      deletion = {
        rootStatus: deploymentStack.stackStatus,
        ownedChildStacksRemaining: Object.values(afterDelete.cloudformation.stacks).filter(stack => stack.parentId && stack.rootId === deploymentStack.stackId && stack.stackStatus !== "DELETE_COMPLETE").length,
        workload: { functions: Object.keys(afterDelete.functions).length, tables: Object.keys(afterDelete.tables).length, appsyncApis: Object.keys(afterDelete.appsync.graphqlApis).length },
        bootstrapPreserved: JSON.stringify(bootstrapIdentity) === JSON.stringify({ bucketName: afterDelete.cloudformation.bootstrap?.bucketName, roleArns: afterDelete.cloudformation.bootstrap?.roleArns, versionParameterName: afterDelete.cloudformation.bootstrap?.versionParameterName }),
        unrelatedStackPreserved: Object.values(afterDelete.cloudformation.stacks).some(stack => stack.stackName === unrelatedStackName && stack.stackStatus === "CREATE_COMPLETE"),
        staleOutputRejected,
        command: watchEdit ? `sandbox delete --identifier ${identifier} --yes` : "DeleteStack",
        cliResult: deleteCliResult,
        secondIdentifierPreserved: secondIdentifier ? Object.values(afterDelete.cloudformation.stacks).some(stack => !stack.parentId && stack.stackName.includes(secondIdentifier) && stack.stackStatus === "CREATE_COMPLETE") : undefined,
      };
      if (watchEdit && process.argv.includes("--recreate")) {
        phase = "same-identifier-recreate";
        const recreateResult = await new Promise((resolvePromise, reject) => {
          const child = spawn(process.execPath, [cli, "sandbox", "--once", "--identifier", identifier], { cwd: fixture, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
          const stdout = []; const stderr = [];
          child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk))); child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
          child.once("error", reject); child.once("close", (code, signal) => resolvePromise({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
        });
        if (recreateResult.code !== 0) throw new Error(`Same-identifier recreation failed: ${recreateResult.stderr || recreateResult.stdout}`);
        const recreatedRoot = Object.values(simulator.store.regionState(region).cloudformation.stacks).find(stack => !stack.parentId && stack.stackName.includes(identifier) && stack.stackStatus === "CREATE_COMPLETE");
        const recreatedOutput = JSON.parse(await readFile(generatedOutputPath, "utf8"));
        const recreatedClientUse = await exerciseAmplifyClient(recreatedOutput, simulator, "amx10-recreated");
        deletion.recreation = {
          result: recreateResult,
          oldRootStackId: deploymentStack.stackId,
          newRootStackId: recreatedRoot?.stackId,
          rootIdentityChanged: Boolean(recreatedRoot && recreatedRoot.stackId !== deploymentStack.stackId),
          completedGeneration: recreatedRoot?.completedDeploymentGeneration,
          clientUse: recreatedClientUse,
        };
        phase = "same-identifier-recreate-cleanup";
        const cleanup = await new Promise((resolvePromise, reject) => {
          const child = spawn(process.execPath, [cli, "sandbox", "delete", "--identifier", identifier, "--yes"], { cwd: fixture, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
          const stdout = []; const stderr = [];
          child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk))); child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
          child.once("error", reject); child.once("close", (code, signal) => resolvePromise({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
        });
        deletion.recreation.cleanup = cleanup;
      }
    }
    const evidence = {
      mode: synthesisOnly ? "synthesis-only" : authEnforce ? "credential-enforced-transport" : "first-failing-deployment",
      result,
      repeatResult,
      repeatEvidence,
      secondIdentifierResult,
      calls,
      optionalNetwork,
      endpointConfiguration: {
        account: accountId,
        region,
        credentials: "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for the configured StackSim administrator",
        globalEndpoint: "AWS_ENDPOINT_URL through the approved loopback tracing proxy",
        serviceSpecificEndpointVariables: [],
        metadataDisabled: "AWS_EC2_METADATA_DISABLED=true",
        proxyVariablesRemoved: true,
      },
      isolation: {
        amplifyTelemetry: "AMPLIFY_DISABLE_TELEMETRY=1",
        amplifyNoticesEndpoint: "isolated approved loopback via AMPLIFY_BACKEND_NOTICES_ENDPOINT",
        amplifyConfigRoot: "fresh APPDATA temporary directory",
        cdkTelemetry: "CDK_DISABLE_CLI_TELEMETRY=true",
        cdkVersionCheck: "CDK_DISABLE_VERSION_CHECK=true",
        npmUpdateNotifier: "npm_config_update_notifier=false",
        instanceMetadata: "AWS_EC2_METADATA_DISABLED=true",
        networkTripwire: "network-tripwire.cjs; loopback proxy and notices ports only",
      },
      files: await listFiles(artifacts).catch(() => []),
      output: outputEvidence,
      clientUse,
      outputIsolation,
      watchEvidence,
      restart,
      deletion,
      successfulStackGraph,
      bootstrap: bootstrap ? {
        descriptor: bootstrap,
        bucket: regional.s3Buckets[bootstrap.bucketName],
        versionParameter: await simulator.ssm.GetParameter({ Name: bootstrap.versionParameterName }),
        roles: bootstrapRoles,
        assets: assetObjects,
      } : null,
      reuse: repeatResult ? (() => {
        const finalAssetVersions = Object.fromEntries(Object.entries(bootstrapIndex?.objects ?? {}).map(([key, versions]) => [key, versions.filter(version => !version.deleteMarker).length]));
        const sharedAssetKeys = Object.keys(firstAssetVersions).filter(key => finalAssetVersions[key] !== undefined).sort();
        const newAssetKeys = Object.keys(finalAssetVersions).filter(key => firstAssetVersions[key] === undefined).sort();
        return {
        descriptorUpdatedAtUnchanged: firstBootstrap?.updatedAt === bootstrap?.updatedAt,
        sharedAssetVersionsUnchanged: sharedAssetKeys.every(key => firstAssetVersions[key] === finalAssetVersions[key]),
        sharedAssetKeys,
        newAssetKeys,
        firstAssetVersions,
        finalAssetVersions,
      };
      })() : null,
      identity: {
        sessions,
        authorizationDecisions,
      },
      recursiveAdmission: recursiveManifest ? {
        schemaVersion: recursiveManifest.schemaVersion,
        totalTemplates: recursiveManifest.totalTemplates,
        totalResources: recursiveManifest.totalResources,
        uniqueTemplateBytes: recursiveManifest.uniqueTemplateBytes,
        admissionFailure: recursiveManifest.admissionFailure,
        templatePins: recursiveTemplatePins,
        rootStackId: deploymentStack.stackId,
        rootStackStatus: deploymentStack.stackStatus,
        rootStackStatusHistory: deploymentStack.events
          .filter(event => event.resourceType === "AWS::CloudFormation::Stack" && event.logicalResourceId === deploymentStack.stackName)
          .map(event => event.resourceStatus),
        rootResourceCount: Object.keys(deploymentStack.resources).length,
        childStackCount: Object.values(regional.cloudformation.stacks).filter(stack => stack.parentId).length,
      } : null,
      stateSummary: {
        stacks: Object.keys(regional.cloudformation.stacks).length,
        buckets: Object.keys(regional.s3Buckets).length,
        functions: Object.keys(regional.functions).length,
        tables: Object.keys(regional.tables).length,
        appsyncApis: Object.keys(regional.appsync.graphqlApis).length,
      },
    };
    const outputIndex = process.argv.indexOf("--output");
    if (outputIndex >= 0) {
      const output = resolve(process.argv[outputIndex + 1]);
      await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    } else {
      console.log(JSON.stringify(evidence, null, 2));
    }
  } finally {
    if (notices) await close(notices);
    if (proxy) await close(proxy.proxy);
    await simulator.stop();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await run();
