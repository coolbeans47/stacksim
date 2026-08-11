import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptsRoot, "..");
const runtimeRoot = join(projectRoot, ".runtime");
const coreOutputsFile = join(runtimeRoot, "core-outputs.json");
const webOutputsFile = join(runtimeRoot, "web-outputs.json");
const deploymentFile = join(runtimeRoot, "deployment.json");
const cdkCli = require.resolve("aws-cdk/bin/cdk");

const DEMO_API_KEY = "AuroraAtlasLocalKey2026";
const DEMO_TOKEN = "aurora-demo";
const EXPECTED_SEED_COUNT = 12;

function endpoint(name, value, fallback) {
  const candidate = String(value || fallback).trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials, query parameters, or a fragment`);
  }
  return candidate;
}

const controlPlaneEndpoint = endpoint("AWS_ENDPOINT_URL", process.env.AWS_ENDPOINT_URL, "http://127.0.0.1:4566");
const invokeEndpoint = endpoint("STACKSIM_INVOKE_ENDPOINT", process.env.STACKSIM_INVOKE_ENDPOINT, "http://127.0.0.1:4567");
const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || process.env.CDK_DEFAULT_REGION || "eu-west-1";
const account = process.env.CDK_DEFAULT_ACCOUNT || process.env.STACKSIM_ACCOUNT_ID || "000000000000";

function localEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("AWS_ENDPOINT_URL_") || ["AWS_PROFILE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].includes(key)) {
      delete environment[key];
    }
  }
  const noProxy = ["127.0.0.1", "localhost", "::1", environment.NO_PROXY, environment.no_proxy]
    .filter(Boolean)
    .join(",");
  return {
    ...environment,
    AWS_ACCESS_KEY_ID: environment.AWS_ACCESS_KEY_ID || "admin",
    AWS_SECRET_ACCESS_KEY: environment.AWS_SECRET_ACCESS_KEY || "password",
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    AWS_ENDPOINT_URL: controlPlaneEndpoint,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_MAX_ATTEMPTS: environment.AWS_MAX_ATTEMPTS || "1",
    CDK_DEFAULT_ACCOUNT: account,
    CDK_DEFAULT_REGION: region,
    CDK_DISABLE_CLI_TELEMETRY: "true",
    CDK_DISABLE_VERSION_CHECK: "true",
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    ...overrides,
  };
}

async function run(label, args, environment = localEnvironment()) {
  console.log(`\n[aurora-atlas] ${label}`);
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env: environment,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${label} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}

async function runCdk(label, args) {
  return run(label, [cdkCli, ...args, "--no-notices", "--no-color"]);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function requiredOutput(outputs, stackName, key) {
  const value = outputs?.[stackName]?.[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`CDK outputs did not include ${stackName}.${key}`);
  }
  return value.trim();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function requireSimulator() {
  let response;
  try {
    response = await fetchWithTimeout(`${controlPlaneEndpoint}/_stacksim/health`, {}, 5_000);
  } catch (error) {
    throw new Error(`stacksim is not reachable at ${controlPlaneEndpoint}: ${error.message}`);
  }
  if (!response.ok) throw new Error(`stacksim health check returned HTTP ${response.status}`);
  const health = await response.json();
  if (health.status !== "ok" || !health.services?.includes("cloudformation")) {
    throw new Error(`The endpoint at ${controlPlaneEndpoint} is not a healthy CloudFormation-capable stacksim`);
  }
  console.log(`[aurora-atlas] stacksim is healthy in ${region}`);
}

async function seedDemo(apiBaseUrl) {
  const target = `${apiBaseUrl}/demo/seed`;
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetchWithTimeout(target, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${DEMO_TOKEN}`,
          "content-type": "application/json",
          "x-api-key": DEMO_API_KEY,
        },
        body: JSON.stringify({ reset: false }),
      });
      const raw = await response.text();
      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = { raw };
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.error || body.message || raw || "seed request failed"}`);
      if (!Number.isInteger(body.total) || body.total < EXPECTED_SEED_COUNT) {
        throw new Error(`seed response reported ${body.total ?? "no"} signals; expected at least ${EXPECTED_SEED_COUNT}`);
      }
      console.log(`[aurora-atlas] demo seed ready (${body.written} written, ${body.total} total)`);
      return body;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise(resolvePromise => setTimeout(resolvePromise, attempt * 500));
    }
  }
  throw new Error(`Unable to seed Aurora Atlas through ${target}: ${lastError?.message || "unknown error"}`);
}

async function main() {
  await mkdir(runtimeRoot, { recursive: true });
  await requireSimulator();

  const placeholderUrl = `${invokeEndpoint}/aurora-demo/prod`;
  await run(
    "build placeholder React application",
    [join(projectRoot, "frontend", "build.mjs")],
    localEnvironment({
      STACKSIM_API_BASE_URL: placeholderUrl,
      AURORA_DEMO_API_KEY: DEMO_API_KEY,
      AURORA_DEMO_TOKEN: DEMO_TOKEN,
    }),
  );
  await runCdk("synthesize all three stacks", ["synth"]);
  await run("verify the 31-provider assembly", [join(scriptsRoot, "verify-assembly.mjs")]);

  await runCdk("deploy the DynamoDB and application stacks", [
    "deploy",
    "AuroraAtlasDataStack",
    "AuroraAtlasApiStack",
    "--exclusively",
    "--require-approval",
    "never",
    "--outputs-file",
    coreOutputsFile,
  ]);

  const coreOutputs = await readJson(coreOutputsFile);
  const apiId = requiredOutput(coreOutputs, "AuroraAtlasApiStack", "ApiId");
  const stageName = requiredOutput(coreOutputs, "AuroraAtlasApiStack", "StageName");
  const apiBaseUrl = `${invokeEndpoint}/${encodeURIComponent(apiId)}/${encodeURIComponent(stageName)}`;
  const seed = await seedDemo(apiBaseUrl);

  await run(
    "rebuild React with the deployed local API identity",
    [join(projectRoot, "frontend", "build.mjs")],
    localEnvironment({
      STACKSIM_API_BASE_URL: apiBaseUrl,
      AURORA_DEMO_API_KEY: DEMO_API_KEY,
      AURORA_DEMO_TOKEN: DEMO_TOKEN,
    }),
  );

  await runCdk("deploy only the public S3 website stack", [
    "deploy",
    "AuroraAtlasWebStack",
    "--exclusively",
    "--require-approval",
    "never",
    "--outputs-file",
    webOutputsFile,
  ]);

  const webOutputs = await readJson(webOutputsFile);
  const deployment = {
    schemaVersion: 1,
    deployedAt: new Date().toISOString(),
    region,
    account,
    controlPlaneEndpoint,
    invokeEndpoint,
    apiBaseUrl,
    apiId,
    stageName,
    websiteUrl: requiredOutput(webOutputs, "AuroraAtlasWebStack", "WebsiteUrl"),
    websiteBucketName: requiredOutput(webOutputs, "AuroraAtlasWebStack", "WebsiteBucketName"),
    tableName: requiredOutput(coreOutputs, "AuroraAtlasDataStack", "SignalsTableName"),
    journeyTableName: requiredOutput(coreOutputs, "AuroraAtlasDataStack", "JourneyTableName"),
    functionName: requiredOutput(coreOutputs, "AuroraAtlasApiStack", "FunctionName"),
    functionVersion: requiredOutput(coreOutputs, "AuroraAtlasApiStack", "FunctionVersion"),
    aliasArn: requiredOutput(coreOutputs, "AuroraAtlasApiStack", "AliasArn"),
    logGroupName: requiredOutput(coreOutputs, "AuroraAtlasApiStack", "ApplicationLogGroup"),
    journeyBusName: requiredOutput(coreOutputs, "AuroraAtlasApiStack", "JourneyBusName"),
    journeyQueueUrl: requiredOutput(coreOutputs, "AuroraAtlasApiStack", "JourneyQueueUrl"),
    journeyDeadLetterQueueUrl: requiredOutput(coreOutputs, "AuroraAtlasApiStack", "JourneyDeadLetterQueueUrl"),
    expectedSeedCount: EXPECTED_SEED_COUNT,
    seed,
    stacks: {
      AuroraAtlasDataStack: coreOutputs.AuroraAtlasDataStack,
      AuroraAtlasApiStack: coreOutputs.AuroraAtlasApiStack,
      AuroraAtlasWebStack: webOutputs.AuroraAtlasWebStack,
    },
  };
  await writeFile(deploymentFile, `${JSON.stringify(deployment, null, 2)}\n`, "utf8");
  console.log(`[aurora-atlas] deployment manifest written to ${deploymentFile}`);

  await run("run deployed full-stack smoke test", [join(scriptsRoot, "smoke-test.mjs")]);
  console.log(`\n[aurora-atlas] ready: ${deployment.websiteUrl}`);
  console.log("[aurora-atlas] all three stacks remain deployed for exploration");
}

main().catch(error => {
  console.error(`\n[aurora-atlas] deployment failed: ${error.stack || error.message}`);
  console.error("[aurora-atlas] Any successfully created stacks have been left in place for inspection.");
  process.exitCode = 1;
});
