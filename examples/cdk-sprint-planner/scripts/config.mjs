import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const forbidden = /(?:secret|password|token|confirmation.?code|access.?key|credential)/i;

function fail(message) {
  throw new Error(`Sprint Planner config: ${message}`);
}

function exactKeys(value, expected, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${path} must be an object`);
  const unknown = Object.keys(value).find(key => !expected.includes(key));
  if (unknown) fail(`${path}.${unknown} is not supported`);
}

function normalizedEmail(value, path) {
  if (typeof value !== "string") fail(`${path} must be an email address`);
  const normalized = value.normalize("NFC").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized) || normalized.length > 254) fail(`${path} must be an email address`);
  return normalized;
}

function endpoint(value, path) {
  let parsed;
  try { parsed = new URL(value); } catch { fail(`${path} must be a URL`); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    fail(`${path} must be a root HTTP(S) URL without credentials, query, or fragment`);
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) fail(`${path} must use a loopback host`);
  return parsed.origin;
}

export async function loadConfig(file = process.env.SPRINT_PLANNER_CONFIG) {
  const configPath = file
    ? isAbsolute(file) ? file : resolve(process.cwd(), file)
    : join(projectRoot, "config", "local.json");
  let raw;
  try { raw = JSON.parse(await readFile(configPath, "utf8")); }
  catch (error) { fail(`cannot read ${configPath}: ${error.message}`); }
  if (Object.keys(raw).some(key => forbidden.test(key))) fail("secret-like top-level fields are forbidden");
  exactKeys(raw, ["schemaVersion", "accountId", "region", "controlPlaneEndpoint", "invokeEndpoint", "bootstrapAdmin", "email"], "config");
  exactKeys(raw.bootstrapAdmin, ["email", "displayName"], "bootstrapAdmin");
  exactKeys(raw.email, ["fromAddress"], "email");
  if (raw.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (!/^\d{12}$/.test(raw.accountId)) fail("accountId must contain 12 digits");
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(raw.region)) fail("region must be a standard aws Region");
  if (typeof raw.bootstrapAdmin.displayName !== "string" || raw.bootstrapAdmin.displayName.trim().length < 1 || raw.bootstrapAdmin.displayName.trim().length > 80) fail("bootstrapAdmin.displayName must be 1–80 characters");
  const controlPlaneEndpoint = endpoint(raw.controlPlaneEndpoint, "controlPlaneEndpoint");
  const invokeEndpoint = endpoint(raw.invokeEndpoint, "invokeEndpoint");
  const email = normalizedEmail(raw.bootstrapAdmin.email, "bootstrapAdmin.email");
  const fromAddress = normalizedEmail(raw.email.fromAddress, "email.fromAddress");
  return Object.freeze({
    schemaVersion: 1,
    accountId: raw.accountId,
    region: raw.region,
    controlPlaneEndpoint,
    invokeEndpoint,
    bootstrapAdmin: Object.freeze({
      email,
      emailHash: createHash("sha256").update(email).digest("hex"),
      displayName: raw.bootstrapAdmin.displayName.normalize("NFC").trim()
    }),
    email: Object.freeze({ fromAddress }),
    configPath
  });
}

export function publicRuntime(config, values = {}) {
  return {
    schemaVersion: 1,
    region: config.region,
    cognitoEndpoint: new URL(values.websiteUrl ?? config.controlPlaneEndpoint).origin,
    userPoolId: values.userPoolId ?? `${config.region}_pending00`,
    appClientId: values.appClientId ?? "pending000000",
    issuer: values.issuer ?? `https://cognito-idp.${config.region}.amazonaws.com/${config.region}_pending00`,
    apiBaseUrl: values.apiBaseUrl ?? `${config.invokeEndpoint}/pending`,
    websocketUrl: values.websocketUrl ?? `${config.invokeEndpoint.replace(/^http/, "ws")}/pending/live`
  };
}
