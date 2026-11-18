import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const runtimeRoot = join(projectRoot, ".runtime");
export const manifestFile = join(runtimeRoot, "deployment.json");
export function localEndpoint(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Search Lab endpoints must be local HTTP URLs without credentials, query parameters or fragments.",
    );
  return url.href.replace(/\/+$/, "");
}
export const controlPlaneEndpoint = localEndpoint(
  process.env.AWS_ENDPOINT_URL || "http://127.0.0.1:4566",
);
export const invokeEndpoint = localEndpoint(
  process.env.STACKSIM_INVOKE_ENDPOINT || "http://127.0.0.1:4567",
);
export const region =
  process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "eu-west-1";
export const account =
  process.env.CDK_DEFAULT_ACCOUNT ||
  process.env.STACKSIM_ACCOUNT_ID ||
  "000000000000";
export function localEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      key.startsWith("AWS_ENDPOINT_URL_") ||
      [
        "AWS_PROFILE",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
      ].includes(key)
    )
      delete env[key];
  return {
    ...env,
    AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID || "admin",
    AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY || "password",
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    AWS_ENDPOINT_URL: controlPlaneEndpoint,
    STACKSIM_INVOKE_ENDPOINT: invokeEndpoint,
    CDK_DEFAULT_ACCOUNT: account,
    CDK_DEFAULT_REGION: region,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_MAX_ATTEMPTS: "1",
    CDK_DISABLE_CLI_TELEMETRY: "true",
    CDK_DISABLE_VERSION_CHECK: "true",
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    ...overrides,
  };
}
export async function requireSimulator() {
  const response = await fetch(`${controlPlaneEndpoint}/_stacksim/health`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error(`StackSim health check failed: HTTP ${response.status}.`);
  const health = await response.json();
  if (
    health.status !== "ok" ||
    !["cloudformation", "opensearch", "lambda", "apigateway", "s3"].every(
      (service) => health.services?.includes(service),
    )
  )
    throw new Error(
      "Start the current OpenSearch-capable StackSim before deploying.",
    );
}
export async function run(label, args, overrides = {}) {
  console.log(`\n[search-lab] ${label}`);
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env: localEnvironment(overrides),
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`${label} exited with code ${code}.`)),
    );
  });
}
export const runCdk = (label, args) =>
  run(label, [
    createRequire(import.meta.url).resolve("aws-cdk/bin/cdk"),
    ...args,
    "--no-notices",
    "--no-color",
  ]);
export async function readManifest() {
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.controlPlaneEndpoint !== controlPlaneEndpoint ||
    manifest.invokeEndpoint !== invokeEndpoint ||
    manifest.region !== region ||
    manifest.account !== account
  )
    throw new Error(
      "Deployment manifest does not match this StackSim target. Use the same environment settings as deploy.",
    );
  if (
    localEndpoint(manifest.apiBaseUrl) !==
    `${invokeEndpoint}/${encodeURIComponent(manifest.apiId)}/${encodeURIComponent(manifest.stageName)}`
  )
    throw new Error("Deployment API identity does not match its URL.");
  localEndpoint(manifest.websiteUrl);
  return manifest;
}
export async function apiRequest(manifest, path, options = {}) {
  const response = await fetch(`${manifest.apiBaseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      `HTTP ${response.status}: ${body.message || JSON.stringify(body)}`,
    );
  return body;
}
