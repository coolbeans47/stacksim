import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const runtimeRoot = join(projectRoot, ".runtime");
export const manifestFile = join(runtimeRoot, "deployment.json");
export const outputsFile = join(runtimeRoot, "outputs.json");
export const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || process.env.CDK_DEFAULT_REGION || "eu-west-1";
export const account = process.env.STACKSIM_ACCOUNT_ID || process.env.CDK_DEFAULT_ACCOUNT || "000000000000";
export const endpoint = String(process.env.AWS_ENDPOINT_URL || "http://127.0.0.1:4566").replace(/\/+$/, "");

export function awsEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("AWS_ENDPOINT_URL_") || ["AWS_PROFILE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].includes(key)) delete environment[key];
  }
  const noProxy = ["127.0.0.1", "localhost", "::1", environment.NO_PROXY, environment.no_proxy].filter(Boolean).join(",");
  return {
    ...environment,
    AWS_ACCESS_KEY_ID: environment.AWS_ACCESS_KEY_ID || "admin",
    AWS_SECRET_ACCESS_KEY: environment.AWS_SECRET_ACCESS_KEY || "password",
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    AWS_ENDPOINT_URL: endpoint,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_MAX_ATTEMPTS: "1",
    CDK_DEFAULT_ACCOUNT: account,
    CDK_DEFAULT_REGION: region,
    CDK_DISABLE_CLI_TELEMETRY: "true",
    CDK_DISABLE_VERSION_CHECK: "true",
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    ...overrides,
  };
}

export async function readManifest() {
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestFile, "utf8")); }
  catch (error) { throw new Error(`Missing or unreadable deployment manifest ${manifestFile}. Run npm run deploy first. ${error.message}`); }
  if (manifest.schemaVersion !== 1 || manifest.account !== account || manifest.region !== region || manifest.controlPlaneEndpoint !== endpoint) {
    throw new Error(`Deployment manifest targets ${manifest.account}/${manifest.region}/${manifest.controlPlaneEndpoint}, but this command targets ${account}/${region}/${endpoint}. Refusing to continue.`);
  }
  const parsed = new URL(manifest.graphqlEndpoint);
  if (!parsed.pathname.includes(`/${region}/${manifest.apiId}`)) throw new Error("Deployment manifest GraphQL endpoint does not match its Region and API ID.");
  for (const key of ["apiKey", "usersTableName", "ticketsTableName", "websiteUrl", "websiteBucketName"]) {
    if (typeof manifest[key] !== "string" || !manifest[key]) throw new Error(`Deployment manifest is missing ${key}.`);
  }
  return manifest;
}

export async function graphqlRequest(manifest, query, variables = {}) {
  const response = await fetch(manifest.graphqlEndpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "x-api-key": manifest.apiKey },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errors?.length) throw new Error(body.errors?.map(item => item.message).join("; ") || `GraphQL returned HTTP ${response.status}`);
  return body.data;
}

export function sdkConfig() {
  return {
    endpoint,
    region,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || "admin",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "password",
    },
    maxAttempts: 1,
  };
}
