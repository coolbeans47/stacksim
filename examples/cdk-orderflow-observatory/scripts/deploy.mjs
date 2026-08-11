import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptsRoot, "..");
const runtimeRoot = join(projectRoot, ".runtime");
const applicationOutputsFile = join(runtimeRoot, "application-outputs.json");
const webOutputsFile = join(runtimeRoot, "web-outputs.json");
const deploymentFile = join(runtimeRoot, "deployment.json");
const cdkCli = require.resolve("aws-cdk/bin/cdk");

function endpoint(name, value, fallback) {
  const candidate = String(value || fallback).trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials, query parameters, or a fragment.`);
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
    if (key.startsWith("AWS_ENDPOINT_URL_") || [
      "AWS_PROFILE",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
    ].includes(key)) delete environment[key];
  }
  const noProxy = ["127.0.0.1", "localhost", "::1", environment.NO_PROXY, environment.no_proxy].filter(Boolean).join(",");
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
  console.log(`\n[orderflow] ${label}`);
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

const runCdk = (label, args) => run(label, [cdkCli, ...args, "--no-notices", "--no-color"]);

function requiredOutput(outputs, stackName, key) {
  const value = outputs?.[stackName]?.[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`CDK outputs did not include ${stackName}.${key}.`);
  return value.trim();
}

async function requireSimulator() {
  let response;
  try {
    response = await fetch(`${controlPlaneEndpoint}/_stacksim/health`, { signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    throw new Error(`stacksim is not reachable at ${controlPlaneEndpoint}: ${error.message}`);
  }
  if (!response.ok) throw new Error(`stacksim health check returned HTTP ${response.status}.`);
  const health = await response.json();
  if (
    health.status !== "ok" ||
    !health.services?.includes("cloudformation") ||
    !health.services?.includes("stepfunctions") ||
    !health.services?.includes("lambda") ||
    !health.services?.includes("apigateway")
  ) {
    throw new Error(`The endpoint at ${controlPlaneEndpoint} is not a healthy Step Functions-capable stacksim.`);
  }
  console.log(`[orderflow] stacksim is healthy in ${region}`);
}

async function main() {
  await mkdir(runtimeRoot, { recursive: true });
  await requireSimulator();

  await run("build placeholder React observatory", [join(projectRoot, "frontend", "build.mjs")], localEnvironment({
    STACKSIM_API_BASE_URL: `${invokeEndpoint}/orderflow-placeholder/prod`,
  }));
  await runCdk("synthesize both CDK stacks", ["synth"]);
  await run("verify the Step Functions CDK assembly", [join(scriptsRoot, "verify-assembly.mjs")]);
  await runCdk("deploy the workflow and observation API", [
    "deploy",
    "OrderFlowApplicationStack",
    "--exclusively",
    "--require-approval",
    "never",
    "--outputs-file",
    applicationOutputsFile,
  ]);

  const applicationOutputs = JSON.parse(await readFile(applicationOutputsFile, "utf8"));
  const apiId = requiredOutput(applicationOutputs, "OrderFlowApplicationStack", "ApiId");
  const stageName = requiredOutput(applicationOutputs, "OrderFlowApplicationStack", "StageName");
  const apiBaseUrl = `${invokeEndpoint}/${encodeURIComponent(apiId)}/${encodeURIComponent(stageName)}`;

  await run("rebuild React with the deployed API identity", [join(projectRoot, "frontend", "build.mjs")], localEnvironment({
    STACKSIM_API_BASE_URL: apiBaseUrl,
  }));
  await runCdk("deploy the S3 observatory website", [
    "deploy",
    "OrderFlowWebStack",
    "--exclusively",
    "--require-approval",
    "never",
    "--outputs-file",
    webOutputsFile,
  ]);

  const webOutputs = JSON.parse(await readFile(webOutputsFile, "utf8"));
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
    stateMachineArn: requiredOutput(applicationOutputs, "OrderFlowApplicationStack", "StateMachineArn"),
    stateMachineName: requiredOutput(applicationOutputs, "OrderFlowApplicationStack", "StateMachineName"),
    workerFunctionName: requiredOutput(applicationOutputs, "OrderFlowApplicationStack", "WorkerFunctionName"),
    apiFunctionName: requiredOutput(applicationOutputs, "OrderFlowApplicationStack", "ApiFunctionName"),
    websiteUrl: requiredOutput(webOutputs, "OrderFlowWebStack", "WebsiteUrl"),
    websiteBucketName: requiredOutput(webOutputs, "OrderFlowWebStack", "WebsiteBucketName"),
    stacks: {
      OrderFlowApplicationStack: applicationOutputs.OrderFlowApplicationStack,
      OrderFlowWebStack: webOutputs.OrderFlowWebStack,
    },
  };
  await writeFile(deploymentFile, `${JSON.stringify(deployment, null, 2)}\n`, "utf8");
  console.log(`[orderflow] deployment manifest written to ${deploymentFile}`);

  await run("run the deployed workflow smoke test", [join(scriptsRoot, "smoke-test.mjs")]);
  console.log(`\n[orderflow] ready: ${deployment.websiteUrl}`);
  console.log(`[orderflow] inspect the native console at ${controlPlaneEndpoint}/#/step-functions/state-machines`);
  console.log("[orderflow] both stacks remain deployed for exploration");
}

main().catch((error) => {
  console.error(`\n[orderflow] deployment failed: ${error.stack || error.message}`);
  console.error("[orderflow] Any successfully created stacks have been left in place for inspection.");
  process.exitCode = 1;
});
